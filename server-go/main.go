package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"

	socketio "github.com/karagenc/socket.io-go"
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

	chatServer := NewChatServer()
	log.Println("Chat server initialized")

	log.Println("Creating Socket.IO server...")
	sio := socketio.NewServer(nil)
	log.Println("Socket.IO server created")

	log.Println("Setting up socket handlers...")
	chatServer.setupSocketHandlers(sio)

	log.Println("Setting up HTTP routes...")
	mux := newHTTPHandler(chatServer, sio)

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
	log.Printf("Socket.IO endpoint: http://localhost:%s/socket.io/", port)
	log.Printf("API endpoint: http://localhost:%s/api/login", port)
	log.Println("===== READY TO ACCEPT CONNECTIONS ======")

	if err := http.Serve(listener, mux); err != nil {
		log.Fatalf("FATAL: Server stopped: %v", err)
	}
}
