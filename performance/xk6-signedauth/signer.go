package signedauth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ProtonMail/gopenpgp/v2/crypto"
	"go.k6.io/k6/v2/js/modules"
)

func init() {
	modules.Register("k6/x/signedauth", new(Signer))
}

type Signer struct {
	keyRings sync.Map
}

func (signer *Signer) Sign(privateKey, event, userID, sessionID string, claims map[string]interface{}) (map[string]interface{}, error) {
	if strings.TrimSpace(event) == "" || strings.TrimSpace(userID) == "" || strings.TrimSpace(sessionID) == "" {
		return nil, fmt.Errorf("event, userId, and sessionId are required")
	}
	normalizedClaims, err := normalizeClaims(claims)
	if err != nil {
		return nil, err
	}
	nonce, err := secureNonce()
	if err != nil {
		return nil, fmt.Errorf("generate nonce: %w", err)
	}
	timestamp := time.Now().UnixMilli()
	signingInput := buildSigningInput(event, userID, sessionID, timestamp, nonce, normalizedClaims)
	keyRing, err := signer.keyRing(privateKey)
	if err != nil {
		return nil, err
	}
	signature, err := keyRing.SignDetached(crypto.NewPlainMessageFromString(signingInput))
	if err != nil {
		return nil, fmt.Errorf("sign mutation: %w", err)
	}
	armoredSignature, err := signature.GetArmored()
	if err != nil {
		return nil, fmt.Errorf("armor signature: %w", err)
	}
	return map[string]interface{}{
		"version":   "v1",
		"event":     event,
		"userId":    userID,
		"sessionId": sessionID,
		"timestamp": timestamp,
		"nonce":     nonce,
		"claims":    normalizedClaims,
		"signature": armoredSignature,
	}, nil
}

func (signer *Signer) CanonicalInput(event, userID, sessionID string, timestamp int64, nonce string, claims map[string]interface{}) (string, error) {
	normalizedClaims, err := normalizeClaims(claims)
	if err != nil {
		return "", err
	}
	return buildSigningInput(event, userID, sessionID, timestamp, nonce, normalizedClaims), nil
}

func (signer *Signer) keyRing(armoredPrivateKey string) (*crypto.KeyRing, error) {
	if strings.TrimSpace(armoredPrivateKey) == "" {
		return nil, fmt.Errorf("private key is required")
	}
	digest := sha256.Sum256([]byte(armoredPrivateKey))
	cacheKey := hex.EncodeToString(digest[:])
	if cached, ok := signer.keyRings.Load(cacheKey); ok {
		return cached.(*crypto.KeyRing), nil
	}
	privateKey, err := crypto.NewKeyFromArmored(armoredPrivateKey)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	unlocked, err := privateKey.Unlock([]byte(""))
	if err != nil {
		return nil, fmt.Errorf("unlock private key: %w", err)
	}
	keyRing, err := crypto.NewKeyRing(unlocked)
	if err != nil {
		return nil, fmt.Errorf("create private key ring: %w", err)
	}
	actual, _ := signer.keyRings.LoadOrStore(cacheKey, keyRing)
	return actual.(*crypto.KeyRing), nil
}

func normalizeClaims(claims map[string]interface{}) (map[string]string, error) {
	normalized := make(map[string]string, len(claims))
	for key, value := range claims {
		normalizedValue, err := normalizeClaimValue(value)
		if err != nil {
			return nil, fmt.Errorf("normalize claim %q: %w", key, err)
		}
		normalized[key] = normalizedValue
	}
	return normalized, nil
}

func normalizeClaimValue(value interface{}) (string, error) {
	switch typed := value.(type) {
	case nil:
		return "", nil
	case string:
		return typed, nil
	case bool:
		return strconv.FormatBool(typed), nil
	case int:
		return strconv.Itoa(typed), nil
	case int64:
		return strconv.FormatInt(typed, 10), nil
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64), nil
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return "", err
		}
		return string(encoded), nil
	}
}

func buildSigningInput(event, userID, sessionID string, timestamp int64, nonce string, claims map[string]string) string {
	return strings.Join([]string{
		"v1",
		event,
		userID,
		sessionID,
		strconv.FormatInt(timestamp, 10),
		nonce,
		canonicalClaimsString(claims),
	}, "|")
}

func canonicalClaimsString(claims map[string]string) string {
	keys := make([]string, 0, len(claims))
	for key := range claims {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+base64.RawURLEncoding.EncodeToString([]byte(claims[key])))
	}
	return strings.Join(parts, "&")
}

func secureNonce() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}