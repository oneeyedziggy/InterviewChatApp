package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"

	wsrt "chat-server-go/websocket"
)

func main() {
	log.Println("===== STARTING GO SERVER ======")

	// Define CLI flags
	portFlag := flag.String("port", "", "Port to listen on (overrides PORT environment variable)")
	
	// Custom usage message for help
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage of %s:\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  -port string\n\tPort to listen on (overrides PORT environment variable, defaults to %s)\n", DefaultPort)
		fmt.Fprintf(os.Stderr, "  -h, --help\n\tShow this help message detailing application usage and format of arguments\n")
	}
	
	flag.Parse()

	port := *portFlag
	if port == "" {
		port = os.Getenv("PORT")
	}
	if port == "" {
		port = DefaultPort
	}
	log.Printf("Using port: %s", port)

	chatServer := NewChatServer("")
	log.Println("Chat server initialized")

	log.Println("Creating WebSocket server...")
	sio := wsrt.NewServer(nil)
	log.Println("WebSocket server created")

	log.Println("Setting up socket handlers...")
	chatServer.setupSocketHandlers(sio)

	log.Println("Setting up server registry (multi-server support)...")
	serverManager, err := NewServerManager(resolveServerDataDir())
	if err != nil {
		log.Fatalf("FATAL: Cannot initialize server registry: %v", err)
	}
	// Register the already-constructed default tenant so it isn't rebuilt
	// (and so its DB connection isn't opened twice) on first request.
	serverManager.registerDefaultTenant(chatServer, sio)

	log.Println("Setting up HTTP routes...")
	mux := newHTTPHandler(serverManager)

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

	if err := http.Serve(listener, mux); err != nil {
		log.Fatalf("FATAL: Server stopped: %v", err)
	}
}
