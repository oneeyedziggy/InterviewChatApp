package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	server "chat-server-go/internal/server"
	wsrt "chat-server-go/websocket"
)

func main() {
	configureLogging()
	log.Println("===== STARTING GO SERVER ======")

	// Define CLI flags
	portFlag := flag.String("port", "", "Port to listen on (overrides PORT environment variable)")

	// Custom usage message for help
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage of %s:\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  -port string\n\tPort to listen on (overrides PORT environment variable, defaults to %s)\n", server.DefaultPort)
		fmt.Fprintf(os.Stderr, "  -h, --help\n\tShow this help message detailing application usage and format of arguments\n")
	}

	flag.Parse()

	port := *portFlag
	if port == "" {
		port = os.Getenv("PORT")
	}
	if port == "" {
		port = server.DefaultPort
	}
	log.Printf("Using port: %s", port)

	dataDir := server.ResolveServerDataDir()
	if err := server.ValidatePerformanceEnvironment(dataDir); err != nil {
		log.Fatalf("FATAL: Unsafe performance test configuration: %v", err)
	}
	chatServer := server.NewChatServer(server.DefaultStorePath(dataDir))
	log.Println("Chat server initialized")

	log.Println("Creating WebSocket server...")
	sio := wsrt.NewServer(nil)
	log.Println("WebSocket server created")

	log.Println("Setting up socket handlers...")
	chatServer.SetupSocketHandlers(sio)

	log.Println("Setting up server registry (multi-server support)...")
	serverManager, err := server.NewServerManager(dataDir)
	if err != nil {
		log.Fatalf("FATAL: Cannot initialize server registry: %v", err)
	}
	// Register the already-constructed default tenant so it isn't rebuilt
	// (and so its DB connection isn't opened twice) on first request.
	serverManager.RegisterDefaultTenant(chatServer, sio)

	log.Println("Setting up HTTP routes...")
	mux := server.NewHTTPHandler(serverManager)
	var diagnosticsServer *http.Server
	var diagnosticsListener net.Listener
	if diagnosticsAddr := strings.TrimSpace(os.Getenv("DIAGNOSTICS_ADDR")); diagnosticsAddr != "" {
		if !strings.HasPrefix(diagnosticsAddr, "127.0.0.1:") && !strings.HasPrefix(diagnosticsAddr, "localhost:") && !strings.HasPrefix(diagnosticsAddr, "[::1]:") {
			log.Fatalf("FATAL: DIAGNOSTICS_ADDR must bind to loopback, got %q", diagnosticsAddr)
		}
		diagnosticsListener, err = net.Listen("tcp", diagnosticsAddr)
		if err != nil {
			log.Fatalf("FATAL: Cannot listen for diagnostics on %s: %v", diagnosticsAddr, err)
		}
		diagnosticsServer = &http.Server{
			Handler:           server.NewDiagnosticsHandler(serverManager),
			ReadHeaderTimeout: 5 * time.Second,
			IdleTimeout:       30 * time.Second,
		}
		log.Printf("Diagnostics listening on http://%s", diagnosticsListener.Addr())
	}

	log.Println("===== SERVER STARTUP COMPLETE ======")
	log.Printf("Binding to port %s...", port)
	log.Printf("Serving static files from out directory (Next.js static export)")
	log.Printf("Make sure to run 'npm run build' first to generate out directory")

	listener, err := net.Listen("tcp", ":"+port)
	if err != nil {
		log.Fatalf(
			"FATAL: Cannot listen on port %s (%v). Another process is probably still running — stop it (lsof -i :%s) or run ./start.sh to restart cleanly.",
			port, err, port,
		)
	}

	log.Printf("Server listening on: http://localhost:%s", port)
	log.Printf("WebSocket endpoint: ws://localhost:%s/ws/", port)
	log.Printf("API endpoint: http://localhost:%s/api/login", port)
	log.Println("===== READY TO ACCEPT CONNECTIONS ======")

	applicationServer := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
	}
	shutdownSignal, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	if err := serveUntilShutdown(shutdownSignal, applicationServer, listener, diagnosticsServer, diagnosticsListener, serverManager); err != nil {
		log.Printf("Server shutdown completed with errors: %v", err)
		os.Exit(1)
	}
	log.Println("Server shutdown complete")
}

func serveUntilShutdown(
	ctx context.Context,
	applicationServer *http.Server,
	applicationListener net.Listener,
	diagnosticsServer *http.Server,
	diagnosticsListener net.Listener,
	resources io.Closer,
) error {
	serveErrors := make(chan error, 2)
	go func() {
		serveErrors <- normalizeServeError(applicationServer.Serve(applicationListener))
	}()
	if diagnosticsServer != nil && diagnosticsListener != nil {
		go func() {
			serveErrors <- normalizeServeError(diagnosticsServer.Serve(diagnosticsListener))
		}()
	}

	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-serveErrors:
	}

	shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var shutdownErrors []error
	if err := applicationServer.Shutdown(shutdownContext); err != nil {
		shutdownErrors = append(shutdownErrors, fmt.Errorf("shutdown application server: %w", err))
	}
	if resources != nil {
		if err := resources.Close(); err != nil {
			shutdownErrors = append(shutdownErrors, fmt.Errorf("close server resources: %w", err))
		}
	}
	if diagnosticsServer != nil {
		if err := diagnosticsServer.Shutdown(shutdownContext); err != nil {
			shutdownErrors = append(shutdownErrors, fmt.Errorf("shutdown diagnostics server: %w", err))
		}
	}
	if serveErr != nil {
		shutdownErrors = append(shutdownErrors, serveErr)
	}
	return errors.Join(shutdownErrors...)
}

func normalizeServeError(err error) error {
	if err == nil || errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func configureLogging() {
	level := slog.LevelInfo
	switch strings.ToLower(strings.TrimSpace(os.Getenv("LOG_LEVEL"))) {
	case "debug":
		level = slog.LevelDebug
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	slog.SetDefault(slog.New(handler))
	log.SetFlags(0)
	log.SetOutput(slog.NewLogLogger(handler, slog.LevelInfo).Writer())
}
