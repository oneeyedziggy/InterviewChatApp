package server

import (
	"bufio"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	wsrt "chat-server-go/websocket"

	gws "github.com/gorilla/websocket"
)

func TestObserveHTTPRecordsRequestAndResponse(t *testing.T) {
	var counters httpCounters
	handler := observeHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if RequestIDFromContext(r.Context()) != "load-run-1" {
			t.Fatalf("request ID missing from context")
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("created"))
	}), &counters)

	request := httptest.NewRequest(http.MethodPost, "/api/test?secret=hidden", nil)
	request.Header.Set("X-Request-ID", "load-run-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Header().Get("X-Request-ID") != "load-run-1" {
		t.Fatalf("expected request ID response header")
	}
	stats := counters.snapshot()
	if stats.RequestsTotal != 1 || stats.RequestsInFlight != 0 || stats.PeakRequestsInFlight != 1 {
		t.Fatalf("unexpected request stats: %+v", stats)
	}
	if stats.Responses2xx != 1 || stats.ResponseBytes != int64(len("created")) {
		t.Fatalf("unexpected response stats: %+v", stats)
	}
}

func TestObserveHTTPRecoversPanics(t *testing.T) {
	var counters httpCounters
	handler := observeHTTP(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}), &counters)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/panic", nil))

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 response, got %d", response.Code)
	}
	stats := counters.snapshot()
	if stats.Panics != 1 || stats.Responses5xx != 1 {
		t.Fatalf("unexpected panic stats: %+v", stats)
	}
}

func TestObservedResponseWriterPreservesHijacking(t *testing.T) {
	underlying := &hijackableWriter{}
	observed := &observedResponseWriter{ResponseWriter: underlying, status: http.StatusOK}
	connection, _, err := observed.Hijack()
	if err != nil {
		t.Fatalf("Hijack failed: %v", err)
	}
	if connection == nil || !observed.hijacked || observed.status != http.StatusSwitchingProtocols {
		t.Fatalf("hijack state not recorded")
	}
	_ = connection.Close()
	_ = underlying.peer.Close()
}

func TestObserveHTTPPreservesWebSocketUpgrade(t *testing.T) {
	websocketServer := wsrt.NewServer(nil)
	t.Cleanup(func() { _ = websocketServer.Close() })
	var counters httpCounters
	httpServer := httptest.NewServer(observeHTTP(websocketServer, &counters))
	t.Cleanup(httpServer.Close)

	websocketURL := "ws" + strings.TrimPrefix(httpServer.URL, "http")
	client, _, err := gws.DefaultDialer.Dial(websocketURL, nil)
	if err != nil {
		t.Fatalf("dial observed websocket: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	var connected map[string]any
	if err := client.ReadJSON(&connected); err != nil {
		t.Fatalf("read connect envelope: %v", err)
	}
	if connected["event"] != "connect" {
		t.Fatalf("expected connect envelope, got %+v", connected)
	}

	// The handler records the upgrade once it returns, which races the client's
	// first read, so wait for the request to be accounted for.
	var stats HTTPStats
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		stats = counters.snapshot()
		if stats.RequestsInFlight == 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if stats.RequestsTotal != 1 || stats.Responses1xx != 1 {
		t.Fatalf("unexpected upgrade stats: %+v", stats)
	}
}

type hijackableWriter struct {
	header http.Header
	peer   net.Conn
}

func (w *hijackableWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *hijackableWriter) Write(data []byte) (int, error) { return len(data), nil }
func (w *hijackableWriter) WriteHeader(int)                {}

func (w *hijackableWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	server, peer := net.Pipe()
	w.peer = peer
	return server, bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server)), nil
}
