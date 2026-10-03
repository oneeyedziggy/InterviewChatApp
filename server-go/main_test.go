package main

import (
	"context"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

type closeCounter struct {
	count atomic.Int64
}

func (closer *closeCounter) Close() error {
	closer.count.Add(1)
	return nil
}

func TestServeUntilShutdownClosesResources(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})}
	closer := &closeCounter{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan error, 1)
	go func() {
		done <- serveUntilShutdown(ctx, server, listener, nil, nil, closer)
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serveUntilShutdown failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for graceful shutdown")
	}
	if closer.count.Load() != 1 {
		t.Fatalf("resource close count = %d, want 1", closer.count.Load())
	}
}
