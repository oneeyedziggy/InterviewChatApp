package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	server "chat-server-go/internal/server"

	"github.com/ProtonMail/gopenpgp/v2/crypto"
	"github.com/ProtonMail/gopenpgp/v2/helper"
	"github.com/google/uuid"
)

type actor struct {
	UserID     string `json:"userId"`
	Username   string `json:"username"`
	SessionID  string `json:"sessionId"`
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
}

type manifest struct {
	Version   int       `json:"version"`
	RunID     string    `json:"runId"`
	BaseURL   string    `json:"baseUrl"`
	ServerID  string    `json:"serverId,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	Actors    []actor   `json:"actors"`
}

type fixtureClient struct {
	baseURL   *url.URL
	serverID  string
	http      *http.Client
	serverKey string
}

func main() {
	baseURL := flag.String("base-url", "http://127.0.0.1:3001", "Go server base URL")
	serverID := flag.String("server", "", "optional tenant ID or alias")
	actorCount := flag.Int("actors", 1, "number of actors to register")
	output := flag.String("output", "", "manifest path under SERVER_DATA_DIR")
	overwrite := flag.Bool("overwrite", false, "replace an existing manifest")
	flag.Parse()

	if err := run(context.Background(), *baseURL, *serverID, *actorCount, *output, *overwrite); err != nil {
		fmt.Fprintln(os.Stderr, "perf-fixtures:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, rawBaseURL, serverID string, actorCount int, output string, overwrite bool) error {
	dataDir := server.ResolveServerDataDir()
	if err := server.ValidatePerformanceEnvironment(dataDir); err != nil {
		return fmt.Errorf("unsafe performance environment: %w", err)
	}
	if err := server.ValidatePerformanceTarget(rawBaseURL); err != nil {
		return fmt.Errorf("unsafe performance target: %w", err)
	}
	if actorCount < 1 || actorCount > 1000 {
		return fmt.Errorf("actors must be between 1 and 1000")
	}
	outputPath, err := safeOutputPath(dataDir, output)
	if err != nil {
		return err
	}
	if !overwrite {
		if _, err := os.Stat(outputPath); err == nil {
			return fmt.Errorf("manifest already exists: %s", outputPath)
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("inspect manifest: %w", err)
		}
	}

	parsedBaseURL, err := url.Parse(rawBaseURL)
	if err != nil || parsedBaseURL.Scheme == "" || parsedBaseURL.Host == "" {
		return fmt.Errorf("invalid base URL")
	}
	client := &fixtureClient{
		baseURL:  parsedBaseURL,
		serverID: strings.TrimSpace(serverID),
		http:     &http.Client{Timeout: 20 * time.Second},
	}
	if err := client.loadServerKey(ctx); err != nil {
		return err
	}

	actors := make([]actor, 0, actorCount)
	var inviter actor
	for index := 0; index < actorCount; index++ {
		inviteCode := ""
		if index > 0 {
			inviteCode, err = client.createInvite(ctx, inviter)
			if err != nil {
				return fmt.Errorf("create invite for actor %d: %w", index, err)
			}
		}
		created, err := client.registerActor(ctx, index, inviteCode)
		if err != nil {
			return fmt.Errorf("register actor %d: %w", index, err)
		}
		actors = append(actors, created)
		if index == 0 {
			inviter = created
			if err := client.waitForInviteRequirement(ctx); err != nil && actorCount > 1 {
				return err
			}
		}
	}

	result := manifest{
		Version:   1,
		RunID:     strings.TrimSpace(os.Getenv("PERFORMANCE_RUN_ID")),
		BaseURL:   parsedBaseURL.String(),
		ServerID:  client.serverID,
		CreatedAt: time.Now().UTC(),
		Actors:    actors,
	}
	return writeManifest(outputPath, result)
}

func safeOutputPath(dataDir, output string) (string, error) {
	root, err := filepath.Abs(dataDir)
	if err != nil {
		return "", fmt.Errorf("resolve data directory: %w", err)
	}
	if strings.TrimSpace(output) == "" {
		output = filepath.Join(root, "fixtures.json")
	} else if !filepath.IsAbs(output) {
		output = filepath.Join(root, output)
	}
	absoluteOutput, err := filepath.Abs(output)
	if err != nil {
		return "", fmt.Errorf("resolve output path: %w", err)
	}
	relative, err := filepath.Rel(root, absoluteOutput)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("output must remain inside SERVER_DATA_DIR")
	}
	if filepath.Ext(absoluteOutput) != ".json" {
		return "", fmt.Errorf("output must use a .json extension")
	}
	return absoluteOutput, nil
}

func writeManifest(path string, value manifest) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("encode manifest: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create manifest directory: %w", err)
	}
	temporary := path + ".tmp"
	_ = os.Remove(temporary)
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("write manifest: %w", err)
	}
	if _, err := file.Write(append(encoded, '\n')); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("write manifest: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("close manifest: %w", err)
	}
	if err := os.Chmod(temporary, 0o600); err != nil {
		return fmt.Errorf("protect manifest: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		return fmt.Errorf("publish manifest: %w", err)
	}
	return nil
}

func (client *fixtureClient) endpoint(path string) string {
	reference := &url.URL{Path: path}
	endpoint := client.baseURL.ResolveReference(reference)
	if client.serverID != "" {
		query := endpoint.Query()
		query.Set("server", client.serverID)
		endpoint.RawQuery = query.Encode()
	}
	return endpoint.String()
}

func (client *fixtureClient) loadServerKey(ctx context.Context) error {
	var response struct {
		PublicKey string `json:"publicKey"`
	}
	if err := client.requestJSON(ctx, http.MethodGet, "/api/server-public-key", nil, &response); err != nil {
		return fmt.Errorf("fetch server public key: %w", err)
	}
	if strings.TrimSpace(response.PublicKey) == "" {
		return fmt.Errorf("server returned an empty public key")
	}
	client.serverKey = response.PublicKey
	return nil
}

func (client *fixtureClient) registerActor(ctx context.Context, index int, inviteCode string) (actor, error) {
	username := fmt.Sprintf("perf-%s-%04d", os.Getenv("PERFORMANCE_RUN_ID"), index)
	privateKey, err := helper.GenerateKey(username, username+"@perf.invalid", []byte(""), "rsa", 2048)
	if err != nil {
		return actor{}, fmt.Errorf("generate key: %w", err)
	}
	private, err := crypto.NewKeyFromArmored(privateKey)
	if err != nil {
		return actor{}, fmt.Errorf("parse private key: %w", err)
	}
	public, err := private.GetArmoredPublicKey()
	if err != nil {
		return actor{}, fmt.Errorf("armor public key: %w", err)
	}
	usernameCiphertext, err := encryptForPublicKey(username, public)
	if err != nil {
		return actor{}, fmt.Errorf("encrypt username: %w", err)
	}
	usernameDigest := sha256.Sum256([]byte(username))
	request := server.LoginRequest{
		UserID:             uuid.NewString(),
		UsernameHash:       hex.EncodeToString(usernameDigest[:]),
		UsernameCiphertext: usernameCiphertext,
		PublicKey:          public,
		InviteCode:         inviteCode,
	}
	var response server.LoginResponse
	if err := client.requestJSON(ctx, http.MethodPost, "/api/login", request, &response); err != nil {
		return actor{}, err
	}
	if response.Error != "" {
		return actor{}, fmt.Errorf("registration rejected: %s", response.Error)
	}
	if response.SessionID == "" || response.UserID != request.UserID {
		return actor{}, fmt.Errorf("registration returned incomplete identity")
	}
	return actor{UserID: request.UserID, Username: username, SessionID: response.SessionID, PublicKey: public, PrivateKey: privateKey}, nil
}

func (client *fixtureClient) createInvite(ctx context.Context, inviter actor) (string, error) {
	request := server.CreateInviteRequest{UserID: inviter.UserID, SessionID: inviter.SessionID}
	var response server.CreateInviteResponse
	if err := client.requestJSON(ctx, http.MethodPost, "/api/invites", request, &response); err != nil {
		return "", err
	}
	if response.Error != "" || response.Code == "" {
		return "", fmt.Errorf("invite rejected: %s", response.Error)
	}
	return response.Code, nil
}

func (client *fixtureClient) waitForInviteRequirement(ctx context.Context) error {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var response struct {
			RequiresInvite bool `json:"requiresInvite"`
		}
		if err := client.requestJSON(ctx, http.MethodGet, "/api/server-status", nil, &response); err == nil && response.RequiresInvite {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("timed out waiting for first actor persistence")
}

func (client *fixtureClient) requestJSON(ctx context.Context, method, path string, requestValue, responseValue any) error {
	var body io.Reader
	if requestValue != nil {
		encoded, err := json.Marshal(requestValue)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, client.endpoint(path), body)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("%s returned %s: %s", path, response.Status, strings.TrimSpace(string(message)))
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(responseValue); err != nil {
		return fmt.Errorf("decode %s response: %w", path, err)
	}
	return nil
}

func encryptForPublicKey(plaintext, armoredPublicKey string) (string, error) {
	publicKey, err := crypto.NewKeyFromArmored(armoredPublicKey)
	if err != nil {
		return "", err
	}
	keyRing, err := crypto.NewKeyRing(publicKey)
	if err != nil {
		return "", err
	}
	encrypted, err := keyRing.Encrypt(crypto.NewPlainMessageFromString(plaintext), nil)
	if err != nil {
		return "", err
	}
	return encrypted.GetArmored()
}
