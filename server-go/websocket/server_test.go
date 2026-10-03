package websocket

import (
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	gws "github.com/gorilla/websocket"
)

func TestConcurrentEmitsDeliverCompleteEnvelopes(t *testing.T) {
	server := NewServer(nil)
	httpServer := httptest.NewServer(server)
	t.Cleanup(func() {
		_ = server.Close()
		httpServer.Close()
	})

	websocketURL := "ws" + strings.TrimPrefix(httpServer.URL, "http")
	client, _, err := gws.DefaultDialer.Dial(websocketURL, nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	var connected envelope
	if err := client.ReadJSON(&connected); err != nil {
		t.Fatalf("read connect envelope: %v", err)
	}
	if connected.Event != "connect" {
		t.Fatalf("expected connect envelope, got %q", connected.Event)
	}

	const (
		writers           = 8
		messagesPerWriter = 25
	)
	totalMessages := writers * messagesPerWriter
	received := make(chan envelope, totalMessages)
	readErrors := make(chan error, 1)
	go func() {
		for index := 0; index < totalMessages; index++ {
			var message envelope
			if err := client.ReadJSON(&message); err != nil {
				readErrors <- err
				return
			}
			received <- message
		}
	}()

	start := make(chan struct{})
	var emitters sync.WaitGroup
	for writer := 0; writer < writers; writer++ {
		emitters.Add(1)
		go func(writer int) {
			defer emitters.Done()
			<-start
			for sequence := 0; sequence < messagesPerWriter; sequence++ {
				server.Of("/").Emit("load", fmt.Sprintf("%d:%d", writer, sequence))
			}
		}(writer)
	}
	close(start)
	emitters.Wait()

	timeout := time.NewTimer(5 * time.Second)
	defer timeout.Stop()
	for index := 0; index < totalMessages; index++ {
		select {
		case err := <-readErrors:
			t.Fatalf("read emitted envelope: %v", err)
		case message := <-received:
			if message.Event != "load" {
				t.Fatalf("expected load envelope, got %q", message.Event)
			}
		case <-timeout.C:
			t.Fatalf("timed out after receiving %d of %d envelopes", index, totalMessages)
		}
	}

	stats := server.Stats()
	if stats.UpgradeAttempts != 1 || stats.UpgradeFailures != 0 {
		t.Fatalf("unexpected upgrade stats: %+v", stats)
	}
	if stats.ActiveConnections != 1 || stats.PeakConnections != 1 {
		t.Fatalf("unexpected connection stats: %+v", stats)
	}
	if stats.FramesSent != int64(totalMessages+1) || stats.BytesSent == 0 || stats.WriteFailures != 0 {
		t.Fatalf("unexpected write stats: %+v", stats)
	}
}

func TestSocketBroadcastExcludesSender(t *testing.T) {
	server := NewServer(nil)
	connectedSockets := make(chan ServerSocket, 2)
	server.Of("/").OnConnection(func(socket ServerSocket) {
		connectedSockets <- socket
	})
	httpServer := httptest.NewServer(server)
	t.Cleanup(func() {
		_ = server.Close()
		httpServer.Close()
	})

	websocketURL := "ws" + strings.TrimPrefix(httpServer.URL, "http")
	firstClient, _, err := gws.DefaultDialer.Dial(websocketURL, nil)
	if err != nil {
		t.Fatalf("dial first websocket: %v", err)
	}
	t.Cleanup(func() { _ = firstClient.Close() })
	var connected envelope
	if err := firstClient.ReadJSON(&connected); err != nil {
		t.Fatalf("read first connect envelope: %v", err)
	}
	firstSocket := <-connectedSockets

	secondClient, _, err := gws.DefaultDialer.Dial(websocketURL, nil)
	if err != nil {
		t.Fatalf("dial second websocket: %v", err)
	}
	t.Cleanup(func() { _ = secondClient.Close() })
	if err := secondClient.ReadJSON(&connected); err != nil {
		t.Fatalf("read second connect envelope: %v", err)
	}
	<-connectedSockets

	firstSocket.Broadcast().Emit("peer-only", "payload")
	var received envelope
	if err := secondClient.ReadJSON(&received); err != nil {
		t.Fatalf("peer did not receive broadcast: %v", err)
	}
	if received.Event != "peer-only" {
		t.Fatalf("unexpected peer event: %q", received.Event)
	}

	if err := firstClient.SetReadDeadline(time.Now().Add(100 * time.Millisecond)); err != nil {
		t.Fatalf("set sender read deadline: %v", err)
	}
	if err := firstClient.ReadJSON(&received); err == nil {
		t.Fatal("sender unexpectedly received its own broadcast")
	}
}
