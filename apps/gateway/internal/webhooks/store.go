package webhooks

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
)

type Registration struct {
	ID       string
	Name     string
	Provider string
	Secret   string
	Events   []string
}

type Store struct {
	mu            sync.RWMutex
	registrations map[string]*Registration
}

func NewStore() *Store {
	return &Store{
		registrations: make(map[string]*Registration),
	}
}

func (s *Store) Register(name, provider, secret string, events []string) *Registration {
	s.mu.Lock()
	defer s.mu.Unlock()

	id := generateWebhookID()
	reg := &Registration{
		ID:       id,
		Name:     name,
		Provider: provider,
		Secret:   secret,
		Events:   events,
	}
	s.registrations[id] = reg
	return reg
}

func (s *Store) Get(webhookID string) (*Registration, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	reg, ok := s.registrations[webhookID]
	return reg, ok
}

func (s *Store) List() []*Registration {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]*Registration, 0, len(s.registrations))
	for _, reg := range s.registrations {
		result = append(result, reg)
	}
	return result
}

func generateWebhookID() string {
	bytes := make([]byte, 8)
	rand.Read(bytes)
	return "wh_" + hex.EncodeToString(bytes)
}
