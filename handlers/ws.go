package handlers

import (
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/gofiber/websocket/v2"
)

const (
	webSocketWriteTimeout = 5 * time.Second
	webSocketReadTimeout  = 90 * time.Second
	webSocketQueueSize    = 64
)

// WebSocket client connections
var (
	clients   = make(map[*websocket.Conn]*webSocketClient)
	clientsMu sync.RWMutex
)

// webSocketClient serializes every write to a connection. The websocket
// implementation supports one concurrent writer only; broadcasts and pong
// responses can otherwise overlap and panic.
type webSocketClient struct {
	conn      webSocketWriter
	writeMu   sync.Mutex
	outgoing  chan []byte
	done      chan struct{}
	stopped   chan struct{}
	closeOnce sync.Once
	closeErr  error
}

type webSocketWriter interface {
	WriteJSON(interface{}) error
	WriteMessage(int, []byte) error
	Close() error
	SetWriteDeadline(time.Time) error
}

func (client *webSocketClient) writeJSON(value interface{}) error {
	client.writeMu.Lock()
	defer client.writeMu.Unlock()
	if err := client.conn.SetWriteDeadline(time.Now().Add(webSocketWriteTimeout)); err != nil {
		return err
	}
	return client.conn.WriteJSON(value)
}

func (client *webSocketClient) writeMessage(messageType int, data []byte) error {
	client.writeMu.Lock()
	defer client.writeMu.Unlock()
	if err := client.conn.SetWriteDeadline(time.Now().Add(webSocketWriteTimeout)); err != nil {
		return err
	}
	return client.conn.WriteMessage(messageType, data)
}

func newWebSocketClient(conn webSocketWriter) *webSocketClient {
	client := &webSocketClient{
		conn:     conn,
		outgoing: make(chan []byte, webSocketQueueSize),
		done:     make(chan struct{}),
		stopped:  make(chan struct{}),
	}
	go client.writeLoop()
	return client
}

// enqueue never waits for network I/O. A suspended phone must not delay item
// saves or updates for other shoppers. Reconnection refreshes missed state.
func (client *webSocketClient) enqueue(data []byte) error {
	select {
	case <-client.done:
		return errors.New("WebSocket client closed")
	default:
	}
	select {
	case <-client.done:
		return errors.New("WebSocket client closed")
	case client.outgoing <- data:
		return nil
	default:
		_ = client.close()
		return errors.New("WebSocket client queue full")
	}
}

func (client *webSocketClient) writeLoop() {
	defer close(client.stopped)
	for {
		select {
		case <-client.done:
			return
		case data := <-client.outgoing:
			if err := client.writeMessage(websocket.TextMessage, data); err != nil {
				log.Printf("Failed to send WebSocket message to client: %v", err)
				_ = client.close()
				return
			}
		}
	}
}

func (client *webSocketClient) close() error {
	client.closeOnce.Do(func() {
		close(client.done)
		// Close is safe concurrently with writes and must interrupt a blocked
		// write instead of waiting to acquire its mutex.
		client.closeErr = client.conn.Close()
	})
	return client.closeErr
}

// WebSocketMessage represents a message sent to clients
type WebSocketMessage struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

// WebSocketHandler handles WebSocket connections
func WebSocketHandler(c *websocket.Conn) {
	client := newWebSocketClient(c)
	c.SetReadLimit(4096)
	_ = c.SetReadDeadline(time.Now().Add(webSocketReadTimeout))

	// Register client
	clientsMu.Lock()
	clients[c] = client
	clientCount := len(clients)
	clientsMu.Unlock()

	log.Printf("WebSocket client connected. Total clients: %d", clientCount)

	defer func() {
		// Unregister client
		clientsMu.Lock()
		delete(clients, c)
		clientCount := len(clients)
		clientsMu.Unlock()
		_ = client.close()
		// Fiber pools connections after this handler returns. Wait until the
		// writer has stopped using this connection before allowing reuse.
		<-client.stopped
		log.Printf("WebSocket client disconnected. Total clients: %d", clientCount)
	}()

	// Keep connection alive and handle incoming messages
	for {
		messageType, msg, err := c.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		_ = c.SetReadDeadline(time.Now().Add(webSocketReadTimeout))

		// Handle ping/pong
		if messageType == websocket.TextMessage {
			var message map[string]string
			if err := json.Unmarshal(msg, &message); err == nil {
				if message["type"] == "ping" {
					if err := client.writeJSON(map[string]string{"type": "pong"}); err != nil {
						log.Printf("Failed to send WebSocket pong: %v", err)
						break
					}
				}
			}
		}
	}
}

// BroadcastUpdate sends an update to all connected WebSocket clients
func BroadcastUpdate(eventType string, data interface{}) {
	message := WebSocketMessage{
		Type: eventType,
		Data: data,
	}

	messageBytes, err := json.Marshal(message)
	if err != nil {
		log.Printf("Failed to marshal WebSocket message: %v", err)
		return
	}

	// Copy the clients while holding the map lock, then release it before any
	// queue operations. Each client writes independently, so stale connections
	// cannot block HTTP handlers or updates to healthy connections.
	clientsMu.RLock()
	clientSnapshot := make([]*webSocketClient, 0, len(clients))
	for _, client := range clients {
		clientSnapshot = append(clientSnapshot, client)
	}
	clientsMu.RUnlock()

	clientCount := len(clientSnapshot)
	log.Printf("Broadcasting %s to %d clients", eventType, clientCount)

	successCount := 0
	for _, client := range clientSnapshot {
		err := client.enqueue(messageBytes)
		if err != nil {
			log.Printf("Failed to send WebSocket message to client: %v", err)
			// Closing the connection wakes the read loop, which unregisters it.
		} else {
			successCount++
		}
	}

	log.Printf("Broadcast %s completed: %d/%d clients queued", eventType, successCount, clientCount)
}

// WebSocketUpgrade middleware to upgrade HTTP to WebSocket
func WebSocketUpgrade(c *websocket.Conn) error {
	return nil
}
