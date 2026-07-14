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

func normalizeBasePath(basePath string) string {
	if basePath == "" || basePath == "/" {
		return ""
	}

	trimmed := strings.Trim(basePath, "/")
	if trimmed == "" {
		return ""
	}

	return "/" + trimmed
}

func stripBasePath(path, basePath string) string {
	if basePath == "" {
		return path
	}

	if path == basePath {
		return "/"
	}

	if strings.HasPrefix(path, basePath+"/") {
		stripped := strings.TrimPrefix(path, basePath)
		if stripped == "" {
			return "/"
		}
		return stripped
	}

	return path
}

func (m *mimeOverrideWriter) WriteHeader(code int) {
	if m.contentType != "" {
		m.Header().Set("Content-Type", m.contentType)
	}
	m.Header().Del("X-Content-Type-Options")
	m.ResponseWriter.WriteHeader(code)
}

func resolveOutDir() string {
	execPath, err := os.Executable()
	if err != nil {
		log.Printf("Warning: unable to resolve executable path (%v), falling back to ../out", err)
		return "../out"
	}

	execDir := filepath.Dir(execPath)
	return filepath.Clean(filepath.Join(execDir, "..", "out"))
}

func newHTTPHandler(chatServer *ChatServer, sio *socketio.Server) http.Handler {
	mux := http.NewServeMux()
	basePath := normalizeBasePath(os.Getenv("APP_BASE_PATH"))
	if basePath == "" {
		log.Println("HTTP base path: <root>")
	} else {
		log.Printf("HTTP base path: %s", basePath)
	}

	mux.HandleFunc("/api/server-public-key", chatServer.handleGetServerPublicKey)
	if basePath != "" {
		mux.HandleFunc(basePath+"/api/server-public-key", chatServer.handleGetServerPublicKey)
	}
	log.Println("Registered /api/server-public-key handler")

	mux.HandleFunc("/api/login", func(w http.ResponseWriter, r *http.Request) {
		log.Printf("===== /api/login REQUEST (wrapper) ======")
		log.Printf("Method: %s", r.Method)
		log.Printf("Remote: %s", r.RemoteAddr)
		log.Printf("URL: %s", r.URL.String())
		chatServer.handleLogin(w, r)
		log.Printf("===== /api/login REQUEST (wrapper) COMPLETE ======")
	})
	if basePath != "" {
		mux.HandleFunc(basePath+"/api/login", func(w http.ResponseWriter, r *http.Request) {
			log.Printf("===== /api/login REQUEST (wrapper) ======")
			log.Printf("Method: %s", r.Method)
			log.Printf("Remote: %s", r.RemoteAddr)
			log.Printf("URL: %s", r.URL.String())
			chatServer.handleLogin(w, r)
			log.Printf("===== /api/login REQUEST (wrapper) COMPLETE ======")
		})
	}
	log.Println("Registered /api/login handler")

	mux.HandleFunc("/api/auth", func(w http.ResponseWriter, r *http.Request) {
		chatServer.handleAuth(w, r)
	})
	if basePath != "" {
		mux.HandleFunc(basePath+"/api/auth", func(w http.ResponseWriter, r *http.Request) {
			chatServer.handleAuth(w, r)
		})
	}
	log.Println("Registered /api/auth handler")

	mux.HandleFunc("/api/delete-user", func(w http.ResponseWriter, r *http.Request) {
		chatServer.handleDeleteUser(w, r)
	})
	if basePath != "" {
		mux.HandleFunc(basePath+"/api/delete-user", func(w http.ResponseWriter, r *http.Request) {
			chatServer.handleDeleteUser(w, r)
		})
	}
	log.Println("Registered /api/delete-user handler")

	mux.Handle("/socket.io/", sio)
	if basePath != "" {
		mux.Handle(basePath+"/socket.io/", http.StripPrefix(basePath, sio))
	}
	log.Println("Registered /socket.io/ handler")

	outDir := resolveOutDir()
	log.Printf("Serving static export from: %s", outDir)
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
	if basePath != "" {
		mux.Handle(basePath+"/_next/", http.StripPrefix(basePath+"/_next/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		if basePath != "" {
			mux.Handle(basePath+"/_next/static/", http.StripPrefix(basePath+"/_next/static/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	}

	serveExportedRoute := func(w http.ResponseWriter, r *http.Request, requestPath string) {
		if strings.HasPrefix(requestPath, "/api/") || strings.HasPrefix(requestPath, "/socket.io/") || strings.HasPrefix(requestPath, "/_next/") {
			http.NotFound(w, r)
			return
		}

		path := requestPath
		if path == "" {
			path = "/"
		}

		candidates := make([]string, 0, 3)
		switch {
		case path == "/":
			candidates = append(candidates, "/index.html")
		case strings.HasSuffix(path, "/"):
			candidates = append(candidates, path+"index.html")
		case strings.HasSuffix(path, ".html"):
			candidates = append(candidates, path)
		default:
			// Support both /route.html and /route/index.html export layouts.
			candidates = append(candidates, path+".html", path+"/index.html")
		}

		for _, candidate := range candidates {
			filePath := filepath.Clean(filepath.Join(outDir, candidate))
			if info, err := os.Stat(filePath); err == nil && !info.IsDir() {
				http.ServeFile(w, r, filePath)
				return
			}
		}

		indexPath := outDir + "/index.html"
		if info, err := os.Stat(indexPath); err == nil && !info.IsDir() {
			http.ServeFile(w, r, indexPath)
			return
		}

		http.NotFound(w, r)
	}

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		serveExportedRoute(w, r, r.URL.Path)
	})

	if basePath != "" {
		mux.HandleFunc(basePath, func(w http.ResponseWriter, r *http.Request) {
			serveExportedRoute(w, r, "/")
		})

		mux.HandleFunc(basePath+"/", func(w http.ResponseWriter, r *http.Request) {
			serveExportedRoute(w, r, stripBasePath(r.URL.Path, basePath))
		})
	}

	return mux
}
