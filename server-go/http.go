package main

import (
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	socketio "github.com/karagenc/socket.io-go"
)

type mimeOverrideWriter struct {
	http.ResponseWriter
	contentType string
}

func (m *mimeOverrideWriter) WriteHeader(code int) {
	if m.contentType != "" {
		m.Header().Set("Content-Type", m.contentType)
	}
	m.Header().Del("X-Content-Type-Options")
	m.ResponseWriter.WriteHeader(code)
}

func newHTTPHandler(chatServer *ChatServer, sio *socketio.Server) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/api/server-public-key", chatServer.handleGetServerPublicKey)
	log.Println("Registered /api/server-public-key handler")

	mux.HandleFunc("/api/login", func(w http.ResponseWriter, r *http.Request) {
		log.Printf("===== /api/login REQUEST (wrapper) ======")
		log.Printf("Method: %s", r.Method)
		log.Printf("Remote: %s", r.RemoteAddr)
		log.Printf("URL: %s", r.URL.String())
		chatServer.handleLogin(w, r)
		log.Printf("===== /api/login REQUEST (wrapper) COMPLETE ======")
	})
	log.Println("Registered /api/login handler")

	mux.HandleFunc("/api/auth", func(w http.ResponseWriter, r *http.Request) {
		chatServer.handleAuth(w, r)
	})
	log.Println("Registered /api/auth handler")

	mux.HandleFunc("/api/delete-user", func(w http.ResponseWriter, r *http.Request) {
		chatServer.handleDeleteUser(w, r)
	})
	log.Println("Registered /api/delete-user handler")

	mux.Handle("/socket.io/", sio)
	log.Println("Registered /socket.io/ handler")

	outDir := "../out"
	if _, err := os.Stat(outDir); os.IsNotExist(err) {
		log.Printf("Warning: out directory not found at %s. Please run 'npm run build' first.", outDir)
	}

	staticDir := outDir + "/_next/static"
	fileServer := http.FileServer(http.Dir(outDir))
	mux.Handle("/_next/", http.StripPrefix("/_next/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ext := filepath.Ext(r.URL.Path)
		var contentType string
		switch ext {
		case ".js":
			contentType = "application/javascript; charset=utf-8"
		case ".css":
			contentType = "text/css; charset=utf-8"
		case ".json":
			contentType = "application/json; charset=utf-8"
		case ".map":
			contentType = "application/json; charset=utf-8"
		default:
			contentType = mime.TypeByExtension(ext)
			if contentType == "" {
				contentType = "application/octet-stream"
			}
		}

		mw := &mimeOverrideWriter{
			ResponseWriter: w,
			contentType:    contentType,
		}
		fileServer.ServeHTTP(mw, r)
	})))

	if _, err := os.Stat(staticDir); err == nil {
		mime.AddExtensionType(".js", "application/javascript")
		mime.AddExtensionType(".css", "text/css")
		mime.AddExtensionType(".json", "application/json")
		mime.AddExtensionType(".map", "application/json")

		fileServer := http.FileServer(http.Dir(staticDir))
		mux.Handle("/_next/static/", http.StripPrefix("/_next/static/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ext := filepath.Ext(r.URL.Path)
			var contentType string
			switch ext {
			case ".js":
				contentType = "application/javascript; charset=utf-8"
			case ".css":
				contentType = "text/css; charset=utf-8"
			case ".json":
				contentType = "application/json; charset=utf-8"
			case ".map":
				contentType = "application/json; charset=utf-8"
			default:
				contentType = mime.TypeByExtension(ext)
				if contentType == "" {
					contentType = "application/octet-stream"
				}
			}
			mw := &mimeOverrideWriter{
				ResponseWriter: w,
				contentType:    contentType,
			}
			fileServer.ServeHTTP(mw, r)
		})))
	}

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/socket.io/") || strings.HasPrefix(r.URL.Path, "/_next/") {
			return
		}

		path := r.URL.Path
		if path == "/" || path == "" {
			path = "/index.html"
		} else if !strings.HasSuffix(path, ".html") {
			htmlPath := outDir + path + ".html"
			if info, err := os.Stat(htmlPath); err == nil && !info.IsDir() {
				http.ServeFile(w, r, htmlPath)
				return
			}
			path = "/index.html"
		}

		filePath := outDir + path
		if info, err := os.Stat(filePath); err == nil && !info.IsDir() {
			http.ServeFile(w, r, filePath)
			return
		}

		indexPath := outDir + "/index.html"
		if info, err := os.Stat(indexPath); err == nil && !info.IsDir() {
			http.ServeFile(w, r, indexPath)
			return
		}

		http.NotFound(w, r)
	})

	return mux
}
