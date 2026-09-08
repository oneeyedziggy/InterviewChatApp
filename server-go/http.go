package main

import (
	"encoding/json"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ProtonMail/gopenpgp/v2/crypto"
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
	// Allow explicit override for local dev (e.g. go run . from server-go/ dir).
	if override := os.Getenv("OUT_DIR"); override != "" {
		return filepath.Clean(override)
	}

	execPath, err := os.Executable()
	if err != nil {
		log.Printf("Warning: unable to resolve executable path (%v), falling back to ../out", err)
		return "../out"
	}

	// go run stores temp binaries under os.TempDir(); fall back to ../out in that case.
	if strings.HasPrefix(execPath, os.TempDir()) {
		return "../out"
	}

	execDir := filepath.Dir(execPath)
	return filepath.Clean(filepath.Join(execDir, "..", "out"))
}

func newHTTPHandler(sm *ServerManager) http.Handler {
	mux := http.NewServeMux()
	basePath := normalizeBasePath(os.Getenv("APP_BASE_PATH"))
	if basePath == "" {
		log.Println("HTTP base path: <root>")
	} else {
		log.Printf("HTTP base path: %s", basePath)
	}

	// tenantHandler resolves the `server` query param to a ChatServer for
	// every request before delegating, so each tenant's data stays isolated.
	tenantHandler := func(fn func(cs *ChatServer, w http.ResponseWriter, r *http.Request)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			tenant, err := sm.GetTenant(resolveServerIDFromRequest(r.URL.Query()))
			if err != nil {
				http.Error(w, "unknown server", http.StatusNotFound)
				return
			}
			fn(tenant.ChatServer, w, r)
		}
	}

	mux.HandleFunc("/api/server-public-key", tenantHandler(func(cs *ChatServer, w http.ResponseWriter, r *http.Request) {
		cs.handleGetServerPublicKey(w, r)
	}))
	if basePath != "" {
		mux.HandleFunc(basePath+"/api/server-public-key", tenantHandler(func(cs *ChatServer, w http.ResponseWriter, r *http.Request) {
			cs.handleGetServerPublicKey(w, r)
		}))
	}
	log.Println("Registered /api/server-public-key handler")

	mux.HandleFunc("/api/server-status", tenantHandler(func(cs *ChatServer, w http.ResponseWriter, r *http.Request) {
		cs.handleServerStatus(w, r)
	}))
	if basePath != "" {
		mux.HandleFunc(basePath+"/api/server-status", tenantHandler(func(cs *ChatServer, w http.ResponseWriter, r *http.Request) {
			cs.handleServerStatus(w, r)
		}))
	}


	creationChallengeHandler := func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var request ServerCreationChallengeRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || strings.TrimSpace(request.PublicKey) == "" {
			http.Error(w, "invalid public key", http.StatusBadRequest)
			return
		}
		if _, err := crypto.NewKeyFromArmored(request.PublicKey); err != nil {
			http.Error(w, "invalid public key", http.StatusBadRequest)
			return
		}
		capability, expiresAt, serverPublicKey := sm.issueCreationCapability(request.PublicKey)
		if capability == "" || serverPublicKey == "" {
			http.Error(w, "failed to prepare server capability", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ServerCreationChallengeResponse{Capability: capability, ExpiresAt: expiresAt, ServerPublicKey: serverPublicKey})
	}
	mux.HandleFunc("/api/server-creation-capability", creationChallengeHandler)
	if basePath != "" {
		mux.HandleFunc(basePath+"/api/server-creation-capability", creationChallengeHandler)
	}

	createServerHandler := func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var request CreateServerRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Capability == "" || request.PublicKey == "" || request.Signature == "" || request.UserID == "" || request.UsernameHash == "" || request.UsernameCiphertext == "" {
			http.Error(w, "invalid creation request", http.StatusBadRequest)
			return
		}
		publicKey, err := crypto.NewKeyFromArmored(request.PublicKey)
		if err != nil {
			http.Error(w, "invalid or expired creation capability", http.StatusUnauthorized)
			return
		}
		verifyRing, err := crypto.NewKeyRing(publicKey)
		if err != nil {
			http.Error(w, "invalid creation key", http.StatusUnauthorized)
			return
		}
		signature, err := crypto.NewPGPSignatureFromArmored(request.Signature)
		if err != nil || verifyRing.VerifyDetached(crypto.NewPlainMessageFromString("server-create:v1:"+request.Capability), signature, time.Now().Unix()) != nil {
			http.Error(w, "invalid creation proof", http.StatusUnauthorized)
			return
		}
		capability, validCapability := sm.consumeCreationCapability(request.Capability, request.PublicKey)
		if !validCapability {
			http.Error(w, "invalid or expired creation capability", http.StatusUnauthorized)
			return
		}
		tenant, err := sm.createTenantWithCapability(capability)
		if err != nil {
			log.Printf("[/api/servers] ✗ failed to create server: %v", err)
			http.Error(w, "failed to create server", http.StatusInternalServerError)
			return
		}
		sessionID, err := sm.registerFirstUser(tenant, request.UserID, request.UsernameHash, request.UsernameCiphertext, request.PublicKey)
		if err != nil {
			http.Error(w, "failed to register first user", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(CreateServerResponse{ServerID: tenant.ID, Alias: tenant.Alias, SessionID: sessionID, ServerPublicKey: capability.TenantPublicKey, UserID: request.UserID})
	}
	mux.HandleFunc("/api/servers", createServerHandler)
	if basePath != "" {
		mux.HandleFunc(basePath+"/api/servers", createServerHandler)
	}
	log.Println("Registered /api/servers handler")

	mux.HandleFunc("/api/login", tenantHandler(func(cs *ChatServer, w http.ResponseWriter, r *http.Request) {
		log.Printf("===== /api/login REQUEST (wrapper) ======")
		log.Printf("Method: %s", r.Method)
		log.Printf("Remote: %s", r.RemoteAddr)
		log.Printf("URL: %s", r.URL.String())
		cs.handleLogin(w, r)
		log.Printf("===== /api/login REQUEST (wrapper) COMPLETE ======")
	}))
	if basePath != "" {
		mux.HandleFunc(basePath+"/api/login", tenantHandler(func(cs *ChatServer, w http.ResponseWriter, r *http.Request) {
			cs.handleLogin(w, r)
		}))
	}
	log.Println("Registered /api/login handler")

	mux.HandleFunc("/api/auth", tenantHandler(func(cs *ChatServer, w http.ResponseWriter, r *http.Request) {
		cs.handleAuth(w, r)
	}))
	if basePath != "" {
		mux.HandleFunc(basePath+"/api/auth", tenantHandler(func(cs *ChatServer, w http.ResponseWriter, r *http.Request) {
			cs.handleAuth(w, r)
		}))
	}
	log.Println("Registered /api/auth handler")

	mux.HandleFunc("/api/delete-user", tenantHandler(func(cs *ChatServer, w http.ResponseWriter, r *http.Request) {
		cs.handleDeleteUser(w, r)
	}))
	if basePath != "" {
		mux.HandleFunc(basePath+"/api/delete-user", tenantHandler(func(cs *ChatServer, w http.ResponseWriter, r *http.Request) {
			cs.handleDeleteUser(w, r)
		}))
	}

	leaveServerHandler := tenantHandler(func(cs *ChatServer, w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "invalid leave request", http.StatusBadRequest)
			return
		}
		r.Body = io.NopCloser(strings.NewReader(string(body)))
		var request DeleteUserRequest
		if err := json.Unmarshal(body, &request); err != nil {
			http.Error(w, "invalid leave request", http.StatusBadRequest)
			return
		}
		cs.mu.RLock()
		owner := false
		for _, creatorID := range cs.roomCreators {
			if creatorID == request.UserID {
				owner = true
				break
			}
		}
		cs.mu.RUnlock()
		if owner {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": "Owner cannot leave server",
				"code":  "owner_cannot_leave",
			})
			return
		}
		cs.handleDeleteUser(w, r)
	})
	mux.HandleFunc("/api/leave-server", leaveServerHandler)
	if basePath != "" {
		mux.HandleFunc(basePath+"/api/leave-server", leaveServerHandler)
	}
	log.Println("Registered /api/leave-server handler")
	log.Println("Registered /api/delete-user handler")

	mux.HandleFunc("/api/invites", tenantHandler(func(cs *ChatServer, w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			cs.handleListInvites(w, r)
			return
		}
		cs.handleCreateInvite(w, r)
	}))
	if basePath != "" {
		mux.HandleFunc(basePath+"/api/invites", tenantHandler(func(cs *ChatServer, w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet {
				cs.handleListInvites(w, r)
				return
			}
			cs.handleCreateInvite(w, r)
		}))
	}
	mux.HandleFunc("/api/invites/revoke", tenantHandler(func(cs *ChatServer, w http.ResponseWriter, r *http.Request) { cs.handleRevokeInvite(w, r) }))
	if basePath != "" {
		mux.HandleFunc(basePath+"/api/invites/revoke", tenantHandler(func(cs *ChatServer, w http.ResponseWriter, r *http.Request) { cs.handleRevokeInvite(w, r) }))
	}
	log.Println("Registered /api/invites handler")

	// /ws/ dispatches to the tenant's own isolated websocket server instance.
	wsHandler := func(w http.ResponseWriter, r *http.Request) {
		tenant, err := sm.GetTenant(resolveServerIDFromRequest(r.URL.Query()))
		if err != nil {
			http.Error(w, "unknown server", http.StatusNotFound)
			return
		}
		tenant.WS.ServeHTTP(w, r)
	}
	mux.HandleFunc("/ws/", wsHandler)
	if basePath != "" {
		mux.Handle(basePath+"/ws/", http.StripPrefix(basePath, http.HandlerFunc(wsHandler)))
	}
	log.Println("Registered /ws/ handler")

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
		if strings.HasPrefix(requestPath, "/api/") || strings.HasPrefix(requestPath, "/ws/") || strings.HasPrefix(requestPath, "/_next/") {
			http.NotFound(w, r)
			return
		}

		path := requestPath
		if path == "" {
			path = "/"
		}

		// Serve direct static asset files (e.g. /private-key-broker-sw.js) before
		// attempting HTML export route resolution.
		if ext := filepath.Ext(path); ext != "" {
			assetPath := filepath.Clean(filepath.Join(outDir, path))
			if info, err := os.Stat(assetPath); err == nil && !info.IsDir() {
				if contentType := mime.TypeByExtension(ext); contentType != "" {
					w.Header().Set("Content-Type", contentType)
				}
				http.ServeFile(w, r, assetPath)
				return
			}
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
