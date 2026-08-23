package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	alertsv1 "github.com/mikesheaksal/vscode-plugin/gen/go/acme/alerts/v1"
	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func main() {
	httpAddr := flag.String("http", "127.0.0.1:8080", "address for the JSON/HTTP gateway")
	grpcAddr := flag.String("grpc", "127.0.0.1:8081", "address for the gRPC service")
	token := flag.String("token", "dev-token", "bearer token the mock accepts")
	clientIDs := flag.String("clients", "dev-9", "comma-separated client ids to serve")
	applyDelay := flag.Duration("apply-delay", 5*time.Second,
		"how long a config change stays APPLYING, so the client's applying state is observable")
	flag.Parse()

	clients := map[string]string{}
	for _, id := range strings.Split(*clientIDs, ",") {
		if id = strings.TrimSpace(id); id != "" {
			clients[id] = *token
		}
	}
	if len(clients) == 0 {
		log.Fatal("at least one client id is required")
	}

	service := newServer(clients, *applyDelay)
	grpcServer := grpc.NewServer()
	alertsv1.RegisterAlertServiceServer(grpcServer, service)

	listener, err := net.Listen("tcp", *grpcAddr)
	if err != nil {
		log.Fatalf("listen %s: %v", *grpcAddr, err)
	}
	go func() {
		if err := grpcServer.Serve(listener); err != nil {
			log.Printf("grpc server stopped: %v", err)
		}
	}()

	gateway, err := newGateway(*grpcAddr)
	if err != nil {
		log.Fatalf("gateway: %v", err)
	}

	httpServer := &http.Server{
		Addr:    *httpAddr,
		Handler: withAdmin(service, gateway),
		// No write timeout: SubscribeEvents is a long-lived stream, and a
		// timeout here would look to the client like a server that keeps
		// dropping the connection.
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("gateway listening on http://%s (grpc on %s)", *httpAddr, *grpcAddr)
		log.Printf("token %q, clients %s", *token, *clientIDs)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
	grpcServer.GracefulStop()
}

func newGateway(grpcAddr string) (http.Handler, error) {
	mux := runtime.NewServeMux(
		// Default proto3 JSON: lowerCamelCase field names, enums as their full
		// string names, uint64 as a string. UseProtoNames would emit
		// gpu_type_id where the generated TypeScript expects gpuTypeId, and the
		// mismatch would not show up until runtime (design section 5.2).
		runtime.WithMarshalerOption(runtime.MIMEWildcard, &runtime.JSONPb{
			MarshalOptions: protojson.MarshalOptions{
				UseProtoNames:   false,
				EmitUnpopulated: false, // keeps an unset gpu_count genuinely absent
			},
			UnmarshalOptions: protojson.UnmarshalOptions{DiscardUnknown: true},
		}),
	)
	conn, err := grpc.NewClient(grpcAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	if err := alertsv1.RegisterAlertServiceHandler(context.Background(), mux, conn); err != nil {
		return nil, err
	}
	return noBuffering(mux), nil
}

// noBuffering sets the headers a proxy needs in order not to hold the streaming
// response back, and is the http.Handler equivalent of the advice in the design
// for whatever sits in front of the real backend.
func noBuffering(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/events") {
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("X-Accel-Buffering", "no")
		}
		next.ServeHTTP(w, r)
	})
}

var alertCounter atomic.Uint64

// withAdmin adds the endpoints the developer CLI drives. They are not part of
// the contract: pushing an alert is something the real backend does for its own
// reasons, and the mock needs a way to be told to do it.
func withAdmin(service *server, gateway http.Handler) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("POST /admin/alerts", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Severity string `json:"severity"`
			Title    string `json:"title"`
			Message  string `json:"message"`
			Modal    bool   `json:"modal"`
			Buttons  []struct {
				ID    string `json:"id"`
				Label string `json:"label"`
			} `json:"buttons"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		alert := &alertsv1.Alert{
			AlertId:   fmt.Sprintf("alt_%d", alertCounter.Add(1)),
			Severity:  parseSeverity(body.Severity),
			Title:     body.Title,
			Message:   body.Message,
			Modal:     body.Modal,
			CreatedAt: timestamppb.Now(),
		}
		for index, button := range body.Buttons {
			alert.Buttons = append(alert.Buttons, &alertsv1.AlertButton{
				ButtonId:  button.ID,
				Label:     button.Label,
				IsPrimary: index == 0,
			})
		}
		service.pushAlert(alert)
		writeJSON(w, map[string]string{"alertId": alert.GetAlertId()})
	})

	mux.HandleFunc("POST /admin/alerts/{id}/revoke", func(w http.ResponseWriter, r *http.Request) {
		if err := service.revokeAlert(r.PathValue("id"), r.URL.Query().Get("reason")); err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		writeJSON(w, map[string]string{"revoked": r.PathValue("id")})
	})

	mux.HandleFunc("GET /admin/streams", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]int{"streams": service.liveStreams()})
	})

	mux.HandleFunc("POST /admin/drop", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]int{"dropped": service.dropAll()})
	})

	mux.Handle("/", gateway)
	return mux
}

func parseSeverity(value string) alertsv1.Severity {
	switch strings.ToLower(value) {
	case "warning":
		return alertsv1.Severity_SEVERITY_WARNING
	case "error":
		return alertsv1.Severity_SEVERITY_ERROR
	default:
		return alertsv1.Severity_SEVERITY_INFO
	}
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}
