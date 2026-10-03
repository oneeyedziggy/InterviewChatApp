package websocket

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	gws "github.com/gorilla/websocket"
)

type SocketID string

type Room string

type Reason string

const ReasonServerShuttingDown Reason = "server shutting down"

type Emitter struct{}

type ServerSocketErrorFunc func(error)

type ServerSocketDisconnectingFunc func(Reason)

type ServerSocketDisconnectFunc func(Reason)

type ServerSocket interface {
	ID() SocketID
	Connected() bool
	Recovered() bool
	Emit(eventName string, v ...any)
	Timeout(timeout time.Duration) Emitter
	OnEvent(eventName string, handler any)
	OnceEvent(eventName string, handler any)
	OffEvent(eventName string, handler ...any)
	OffAll()
	OnError(fn ServerSocketErrorFunc)
	OnceError(fn ServerSocketErrorFunc)
	OffError(fn ...ServerSocketErrorFunc)
	OnDisconnecting(fn ServerSocketDisconnectingFunc)
	OnceDisconnecting(fn ServerSocketDisconnectingFunc)
	OffDisconnecting(fn ...ServerSocketDisconnectingFunc)
	OnDisconnect(fn ServerSocketDisconnectFunc)
	OnceDisconnect(fn ServerSocketDisconnectFunc)
	OffDisconnect(fn ...ServerSocketDisconnectFunc)
	Server() *Server
	Namespace() *Namespace
	Join(room ...Room)
	Leave(room Room)
	Use(fn any)
	To(room ...Room) *BroadcastOperator
	In(room ...Room) *BroadcastOperator
	Except(room ...Room) *BroadcastOperator
	Local() *BroadcastOperator
	Broadcast() *BroadcastOperator
	Disconnect(close bool)
}

type envelope struct {
	Event   string      `json:"event"`
	Payload interface{} `json:"payload"`
}

type incomingEnvelope struct {
	Event   string          `json:"event"`
	Payload json.RawMessage `json:"payload"`
}

type Stats struct {
	UpgradeAttempts   int64 `json:"upgradeAttempts"`
	UpgradeFailures   int64 `json:"upgradeFailures"`
	ActiveConnections int64 `json:"activeConnections"`
	PeakConnections   int64 `json:"peakConnections"`
	FramesReceived    int64 `json:"framesReceived"`
	FramesSent        int64 `json:"framesSent"`
	BytesReceived     int64 `json:"bytesReceived"`
	BytesSent         int64 `json:"bytesSent"`
	WriteFailures     int64 `json:"writeFailures"`
}

type counters struct {
	upgradeAttempts   atomic.Int64
	upgradeFailures   atomic.Int64
	activeConnections atomic.Int64
	peakConnections   atomic.Int64
	framesReceived    atomic.Int64
	framesSent        atomic.Int64
	bytesReceived     atomic.Int64
	bytesSent         atomic.Int64
	writeFailures     atomic.Int64
}

type Server struct {
	upgrader gws.Upgrader

	mu         sync.RWMutex
	sockets    map[SocketID]*wrappedSocket
	rooms      map[Room]map[SocketID]struct{}
	namespaces map[string]*Namespace
	metrics    counters
}

func NewServer(_ any) *Server {
	return &Server{
		upgrader: gws.Upgrader{
			CheckOrigin: func(_ *http.Request) bool { return true },
		},
		sockets:    make(map[SocketID]*wrappedSocket),
		rooms:      make(map[Room]map[SocketID]struct{}),
		namespaces: make(map[string]*Namespace),
	}
}

func (s *Server) Of(name string) *Namespace {
	s.mu.Lock()
	defer s.mu.Unlock()
	if nsp, ok := s.namespaces[name]; ok {
		return nsp
	}
	nsp := &Namespace{server: s}
	s.namespaces[name] = nsp
	return nsp
}

func (s *Server) Close() error {
	s.mu.Lock()
	sockets := make([]*wrappedSocket, 0, len(s.sockets))
	for _, sock := range s.sockets {
		sockets = append(sockets, sock)
	}
	s.mu.Unlock()
	for _, sock := range sockets {
		sock.Disconnect(true)
	}
	return nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.metrics.upgradeAttempts.Add(1)
	if !gws.IsWebSocketUpgrade(r) {
		s.metrics.upgradeFailures.Add(1)
		http.Error(w, "websocket upgrade required", http.StatusBadRequest)
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.metrics.upgradeFailures.Add(1)
		return
	}

	nsp := s.Of("/")
	sock := newWrappedSocket(s, nsp, conn)

	s.mu.Lock()
	s.sockets[sock.id] = sock
	s.mu.Unlock()
	active := s.metrics.activeConnections.Add(1)
	for {
		peak := s.metrics.peakConnections.Load()
		if active <= peak || s.metrics.peakConnections.CompareAndSwap(peak, active) {
			break
		}
	}

	sock.Emit("connect", map[string]interface{}{"id": string(sock.id)})
	nsp.invokeConnectionHandlers(sock)

	go sock.readLoop()
}

func (s *Server) removeSocket(id SocketID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.sockets[id]; !exists {
		return
	}
	delete(s.sockets, id)
	s.metrics.activeConnections.Add(-1)
	for room, members := range s.rooms {
		delete(members, id)
		if len(members) == 0 {
			delete(s.rooms, room)
		}
	}
}

func (s *Server) Stats() Stats {
	return Stats{
		UpgradeAttempts:   s.metrics.upgradeAttempts.Load(),
		UpgradeFailures:   s.metrics.upgradeFailures.Load(),
		ActiveConnections: s.metrics.activeConnections.Load(),
		PeakConnections:   s.metrics.peakConnections.Load(),
		FramesReceived:    s.metrics.framesReceived.Load(),
		FramesSent:        s.metrics.framesSent.Load(),
		BytesReceived:     s.metrics.bytesReceived.Load(),
		BytesSent:         s.metrics.bytesSent.Load(),
		WriteFailures:     s.metrics.writeFailures.Load(),
	}
}

func (s *Server) join(id SocketID, room Room) {
	s.mu.Lock()
	defer s.mu.Unlock()
	members := s.rooms[room]
	if members == nil {
		members = make(map[SocketID]struct{})
		s.rooms[room] = members
	}
	members[id] = struct{}{}
}

func (s *Server) leave(id SocketID, room Room) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if members := s.rooms[room]; members != nil {
		delete(members, id)
		if len(members) == 0 {
			delete(s.rooms, room)
		}
	}
}

func (s *Server) sendToSocketIDs(ids map[SocketID]struct{}, event string, data interface{}) {
	s.mu.RLock()
	sockets := make([]*wrappedSocket, 0, len(ids))
	for id := range ids {
		if sock := s.sockets[id]; sock != nil {
			sockets = append(sockets, sock)
		}
	}
	s.mu.RUnlock()

	for _, sock := range sockets {
		sock.Emit(event, data)
	}
}

func (s *Server) allSocketIDs() map[SocketID]struct{} {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make(map[SocketID]struct{}, len(s.sockets))
	for id := range s.sockets {
		ids[id] = struct{}{}
	}
	return ids
}

func (s *Server) roomSocketIDs(rooms []Room) map[SocketID]struct{} {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make(map[SocketID]struct{})
	for _, room := range rooms {
		for id := range s.rooms[room] {
			ids[id] = struct{}{}
		}
	}
	return ids
}

type Namespace struct {
	server             *Server
	mu                 sync.RWMutex
	connectionHandlers []func(ServerSocket)
}

func (n *Namespace) Emit(event string, data interface{}) {
	n.server.sendToSocketIDs(n.server.allSocketIDs(), event, data)
}

func (n *Namespace) To(room ...Room) *BroadcastOperator {
	return &BroadcastOperator{server: n.server, includeRooms: room}
}

func (n *Namespace) OnConnection(fn func(ServerSocket)) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.connectionHandlers = append(n.connectionHandlers, fn)
}

func (n *Namespace) InvokeConnectionHandlerForTest(index int, socket ServerSocket) bool {
	n.mu.RLock()
	defer n.mu.RUnlock()
	if index < 0 || index >= len(n.connectionHandlers) {
		return false
	}
	n.connectionHandlers[index](socket)
	return true
}

func (n *Namespace) invokeConnectionHandlers(socket ServerSocket) {
	n.mu.RLock()
	handlers := make([]func(ServerSocket), len(n.connectionHandlers))
	copy(handlers, n.connectionHandlers)
	n.mu.RUnlock()
	for _, fn := range handlers {
		fn(socket)
	}
}

type BroadcastOperator struct {
	server           *Server
	includeRooms     []Room
	excludeSocketIDs map[SocketID]struct{}
}

func (b *BroadcastOperator) Emit(event string, data interface{}) {
	ids := b.server.allSocketIDs()
	if len(b.includeRooms) > 0 {
		ids = b.server.roomSocketIDs(b.includeRooms)
	}
	for id := range b.excludeSocketIDs {
		delete(ids, id)
	}
	b.server.sendToSocketIDs(ids, event, data)
}

type wrappedSocket struct {
	id        SocketID
	server    *Server
	namespace *Namespace
	conn      *gws.Conn
	writeMu   sync.Mutex

	mu                    sync.RWMutex
	connected             bool
	eventHandlers         map[string][]func(interface{})
	onceEventHandlers     map[string][]func(interface{})
	errorHandlers         []ServerSocketErrorFunc
	disconnectingHandlers []ServerSocketDisconnectingFunc
	disconnectHandlers    []ServerSocketDisconnectFunc
}

func newWrappedSocket(server *Server, namespace *Namespace, conn *gws.Conn) *wrappedSocket {
	return &wrappedSocket{
		id:                SocketID(uuid.NewString()),
		server:            server,
		namespace:         namespace,
		conn:              conn,
		connected:         true,
		eventHandlers:     make(map[string][]func(interface{})),
		onceEventHandlers: make(map[string][]func(interface{})),
	}
}

func (w *wrappedSocket) ID() SocketID { return w.id }

func (w *wrappedSocket) Connected() bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.connected
}

func (w *wrappedSocket) Recovered() bool { return false }

func (w *wrappedSocket) Emit(eventName string, v ...any) {
	payload := interface{}(nil)
	if len(v) == 1 {
		payload = v[0]
	} else if len(v) > 1 {
		payload = v
	}
	message, err := json.Marshal(envelope{Event: eventName, Payload: payload})
	if err != nil {
		w.server.metrics.writeFailures.Add(1)
		w.notifyError(err)
		return
	}
	w.writeMu.Lock()
	err = w.conn.WriteMessage(gws.TextMessage, message)
	w.writeMu.Unlock()
	if err != nil {
		w.server.metrics.writeFailures.Add(1)
		w.notifyError(err)
		return
	}
	w.server.metrics.framesSent.Add(1)
	w.server.metrics.bytesSent.Add(int64(len(message)))
}

func (w *wrappedSocket) Timeout(timeout time.Duration) Emitter {
	_ = timeout
	return Emitter{}
}

func (w *wrappedSocket) OnEvent(eventName string, handler any) {
	fn, ok := handler.(func(interface{}))
	if !ok {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.eventHandlers[eventName] = append(w.eventHandlers[eventName], fn)
}

func (w *wrappedSocket) OnceEvent(eventName string, handler any) {
	fn, ok := handler.(func(interface{}))
	if !ok {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.onceEventHandlers[eventName] = append(w.onceEventHandlers[eventName], fn)
}

func (w *wrappedSocket) OffEvent(eventName string, handler ...any) {
	_ = handler
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.eventHandlers, eventName)
	delete(w.onceEventHandlers, eventName)
}

func (w *wrappedSocket) OffAll() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.eventHandlers = make(map[string][]func(interface{}))
	w.onceEventHandlers = make(map[string][]func(interface{}))
	w.errorHandlers = nil
	w.disconnectingHandlers = nil
	w.disconnectHandlers = nil
}

func (w *wrappedSocket) OnError(fn ServerSocketErrorFunc) {
	if fn == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.errorHandlers = append(w.errorHandlers, fn)
}

func (w *wrappedSocket) OnceError(fn ServerSocketErrorFunc) { w.OnError(fn) }

func (w *wrappedSocket) OffError(fn ...ServerSocketErrorFunc) {
	_ = fn
	w.mu.Lock()
	defer w.mu.Unlock()
	w.errorHandlers = nil
}

func (w *wrappedSocket) OnDisconnecting(fn ServerSocketDisconnectingFunc) {
	if fn == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.disconnectingHandlers = append(w.disconnectingHandlers, fn)
}

func (w *wrappedSocket) OnceDisconnecting(fn ServerSocketDisconnectingFunc) {
	w.OnDisconnecting(fn)
}

func (w *wrappedSocket) OffDisconnecting(fn ...ServerSocketDisconnectingFunc) {
	_ = fn
	w.mu.Lock()
	defer w.mu.Unlock()
	w.disconnectingHandlers = nil
}

func (w *wrappedSocket) OnDisconnect(fn ServerSocketDisconnectFunc) {
	if fn == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.disconnectHandlers = append(w.disconnectHandlers, fn)
}

func (w *wrappedSocket) OnceDisconnect(fn ServerSocketDisconnectFunc) {
	w.OnDisconnect(fn)
}

func (w *wrappedSocket) OffDisconnect(fn ...ServerSocketDisconnectFunc) {
	_ = fn
	w.mu.Lock()
	defer w.mu.Unlock()
	w.disconnectHandlers = nil
}

func (w *wrappedSocket) Server() *Server { return w.server }

func (w *wrappedSocket) Namespace() *Namespace { return w.namespace }

func (w *wrappedSocket) Join(room ...Room) {
	for _, r := range room {
		w.server.join(w.id, r)
	}
}

func (w *wrappedSocket) Leave(room Room) {
	w.server.leave(w.id, room)
}

func (w *wrappedSocket) Use(fn any) { _ = fn }

func (w *wrappedSocket) To(room ...Room) *BroadcastOperator {
	return &BroadcastOperator{server: w.server, includeRooms: room}
}

func (w *wrappedSocket) In(room ...Room) *BroadcastOperator {
	return w.To(room...)
}

func (w *wrappedSocket) Except(room ...Room) *BroadcastOperator {
	excluded := w.server.roomSocketIDs(room)
	return &BroadcastOperator{server: w.server, excludeSocketIDs: excluded}
}

func (w *wrappedSocket) Local() *BroadcastOperator {
	return &BroadcastOperator{server: w.server}
}

func (w *wrappedSocket) Broadcast() *BroadcastOperator {
	return &BroadcastOperator{
		server:           w.server,
		excludeSocketIDs: map[SocketID]struct{}{w.id: {}},
	}
}

func (w *wrappedSocket) Disconnect(close bool) {
	_ = close
	w.closeWithReason(ReasonServerShuttingDown)
}

func (w *wrappedSocket) readLoop() {
	defer w.closeWithReason(ReasonServerShuttingDown)
	for {
		_, msg, err := w.conn.ReadMessage()
		if err != nil {
			return
		}
		w.server.metrics.framesReceived.Add(1)
		w.server.metrics.bytesReceived.Add(int64(len(msg)))
		var incoming incomingEnvelope
		if err := json.Unmarshal(msg, &incoming); err != nil {
			w.notifyError(err)
			continue
		}
		if incoming.Event == "" {
			w.notifyError(fmt.Errorf("missing event name"))
			continue
		}
		var payload interface{}
		if len(incoming.Payload) > 0 && string(incoming.Payload) != "null" {
			if err := json.Unmarshal(incoming.Payload, &payload); err != nil {
				w.notifyError(err)
				continue
			}
		}
		w.dispatchEvent(incoming.Event, payload)
	}
}

func (w *wrappedSocket) dispatchEvent(name string, payload interface{}) {
	w.mu.Lock()
	handlers := append([]func(interface{}){}, w.eventHandlers[name]...)
	onceHandlers := append([]func(interface{}){}, w.onceEventHandlers[name]...)
	delete(w.onceEventHandlers, name)
	w.mu.Unlock()
	for _, fn := range handlers {
		fn(payload)
	}
	for _, fn := range onceHandlers {
		fn(payload)
	}
}

func (w *wrappedSocket) notifyError(err error) {
	w.mu.RLock()
	handlers := append([]ServerSocketErrorFunc{}, w.errorHandlers...)
	w.mu.RUnlock()
	for _, fn := range handlers {
		fn(err)
	}
}

func (w *wrappedSocket) closeWithReason(reason Reason) {
	w.mu.Lock()
	if !w.connected {
		w.mu.Unlock()
		return
	}
	w.connected = false
	disconnectingHandlers := append([]ServerSocketDisconnectingFunc{}, w.disconnectingHandlers...)
	disconnectHandlers := append([]ServerSocketDisconnectFunc{}, w.disconnectHandlers...)
	w.mu.Unlock()

	for _, fn := range disconnectingHandlers {
		fn(reason)
	}
	for _, fn := range disconnectHandlers {
		fn(reason)
	}

	_ = w.conn.Close()
	w.server.removeSocket(w.id)
}
