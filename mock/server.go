// Package main runs a mock Acme Alerts backend: the real gRPC service behind a
// real grpc-gateway, so the extension develops against the same JSON projection
// the Go backend will serve.
//
// It is a development fixture, not a reference implementation. State is in
// memory, and the only credential check is that a bearer token is present and
// paired with a known client id.
package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	alertsv1 "github.com/mikesheaksal/vscode-plugin/gen/go/acme/alerts/v1"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	heartbeatInterval = 25 * time.Second
	noneGPU           = "none"
	minClientVersion  = "0.1.0"
	cancelWindow      = 30 * time.Second
)

// limits mirror the ranges in docs/DESIGN.md section 5.3.
var limits = &alertsv1.ResourceLimits{
	GpuCountMin: 1, GpuCountMax: 8,
	CpuCoresMin: 1, CpuCoresMax: 256,
	RamGbMin: 1, RamGbMax: 2048,
	SsdGbMin: 1, SsdGbMax: 2048,
}

var gpuTypes = []*alertsv1.GpuType{
	{GpuTypeId: noneGPU, Label: "No GPU", MaxCount: 0},
	{GpuTypeId: "a100-40", Label: "NVIDIA A100 40GB", MaxCount: 8},
	{GpuTypeId: "h100-80", Label: "NVIDIA H100 80GB", MaxCount: 4},
}

type server struct {
	alertsv1.UnimplementedAlertServiceServer

	mu sync.Mutex

	// clients holds the client ids the mock will serve, and the token each is
	// paired with. The pairing check is the point: a token valid for one client
	// must not be able to subscribe to another's alerts (design section 6.0).
	clients map[string]string

	sequence uint64
	events   []*alertsv1.Event
	// subscribers receive every event appended after they registered.
	subscribers map[int]chan *alertsv1.Event
	// drops lets the admin endpoint cut live streams without restarting the
	// process, so a test can lose the connection while the event log survives -
	// what a load balancer restart or an idle timeout looks like from here.
	drops   map[int]chan struct{}
	nextSub int

	// alerts still awaiting a response, by alert id.
	pending   map[string]*alertsv1.Alert
	responses map[string]*alertsv1.RespondToAlertRequest

	config        map[string]*alertsv1.ResourceSpec
	configVersion map[string]int
	pendingChange map[string]*alertsv1.MachineChange

	// Applied changes complete after this delay so the client's APPLYING state
	// is observable. Zero applies immediately.
	applyDelay time.Duration
	// requiresRestart decides the preview's answer. GPU changes need a restart;
	// everything else does not, which is what makes the per-field attribution in
	// the confirmation dialog worth having.
	clock func() time.Time
}

func newServer(clients map[string]string, applyDelay time.Duration) *server {
	s := &server{
		clients:       clients,
		subscribers:   map[int]chan *alertsv1.Event{},
		drops:         map[int]chan struct{}{},
		pending:       map[string]*alertsv1.Alert{},
		responses:     map[string]*alertsv1.RespondToAlertRequest{},
		config:        map[string]*alertsv1.ResourceSpec{},
		configVersion: map[string]int{},
		pendingChange: map[string]*alertsv1.MachineChange{},
		applyDelay:    applyDelay,
		clock:         time.Now,
	}
	for id := range clients {
		s.config[id] = &alertsv1.ResourceSpec{
			GpuTypeId: "a100-40",
			GpuCount:  ptr(uint32(2)),
			CpuCores:  32,
			RamGb:     256,
			SsdGb:     1024,
		}
		s.configVersion[id] = 1
	}
	return s
}

// authorize enforces the rule the design puts on the real server: the bearer
// token must be valid *for the presented client id*. Without this check the
// client id is an authorization bypass rather than a routing key.
func (s *server) authorize(ctx context.Context, clientID string) error {
	md, _ := metadata.FromIncomingContext(ctx)
	var token string
	for _, value := range md.Get("authorization") {
		if after, ok := strings.CutPrefix(value, "Bearer "); ok {
			token = strings.TrimSpace(after)
		}
	}
	if token == "" {
		return status.Error(codes.Unauthenticated, "missing bearer token")
	}
	if clientID == "" {
		return fieldViolation("client_id", "client_id is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	expected, known := s.clients[clientID]
	if !known {
		return status.Errorf(codes.NotFound, "unknown client id %q", clientID)
	}
	if token != expected {
		return status.Errorf(codes.PermissionDenied,
			"token is not authorized for client %q", clientID)
	}
	return nil
}

func (s *server) GetClientInfo(ctx context.Context, req *alertsv1.GetClientInfoRequest) (*alertsv1.GetClientInfoResponse, error) {
	if err := s.authorize(ctx, req.GetClientId()); err != nil {
		return nil, err
	}
	return &alertsv1.GetClientInfoResponse{
		ClientId:         req.GetClientId(),
		DisplayName:      "Mock client " + req.GetClientId(),
		MinClientVersion: minClientVersion,
		ServerTime:       timestamppb.New(s.clock()),
	}, nil
}

func (s *server) SubscribeEvents(req *alertsv1.SubscribeEventsRequest, stream grpc.ServerStreamingServer[alertsv1.Event]) error {
	if err := s.authorize(stream.Context(), req.GetClientId()); err != nil {
		return err
	}

	backlog, updates, dropped, unsubscribe := s.subscribe(req.GetLastSequence())
	defer unsubscribe()

	// An immediate heartbeat, before anything else. grpc-gateway does not flush
	// response headers until the first message, so a stream that opens with
	// nothing to say leaves the client's fetch() unresolved until the first
	// tick. Sending one now means "connected" is observable straight away.
	if err := stream.Send(s.heartbeat()); err != nil {
		return err
	}

	// Replay everything after last_sequence before live events, so a reconnect
	// leaves no gap.
	for _, event := range backlog {
		if err := stream.Send(event); err != nil {
			return err
		}
	}

	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stream.Context().Done():
			return nil
		case <-dropped:
			return status.Error(codes.Unavailable, "connection dropped")
		case event := <-updates:
			if err := stream.Send(event); err != nil {
				return err
			}
		case <-ticker.C:
			// In-band, because NDJSON has no equivalent of an SSE comment frame.
			if err := stream.Send(s.heartbeat()); err != nil {
				return err
			}
		}
	}
}

func (s *server) ListPendingAlerts(ctx context.Context, req *alertsv1.ListPendingAlertsRequest) (*alertsv1.ListPendingAlertsResponse, error) {
	if err := s.authorize(ctx, req.GetClientId()); err != nil {
		return nil, err
	}

	deadline := s.clock().Add(time.Duration(req.GetWaitSeconds()) * time.Second)
	for {
		s.mu.Lock()
		alerts := make([]*alertsv1.Alert, 0, len(s.pending))
		for _, alert := range s.pending {
			alerts = append(alerts, alert)
		}
		sequence := s.sequence
		s.mu.Unlock()

		if len(alerts) > 0 || !s.clock().Before(deadline) {
			return &alertsv1.ListPendingAlertsResponse{Alerts: alerts, Sequence: sequence}, nil
		}
		select {
		case <-ctx.Done():
			return nil, status.FromContextError(ctx.Err()).Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (s *server) RespondToAlert(ctx context.Context, req *alertsv1.RespondToAlertRequest) (*alertsv1.RespondToAlertResponse, error) {
	if err := s.authorize(ctx, req.GetClientId()); err != nil {
		return nil, err
	}
	if req.GetOutcome() == alertsv1.AlertOutcome_ALERT_OUTCOME_UNSPECIFIED {
		return nil, fieldViolation("outcome", "outcome is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	alert, live := s.pending[req.GetAlertId()]
	previous, answered := s.responses[req.GetAlertId()]

	switch {
	case answered && previous.GetIdempotencyKey() == req.GetIdempotencyKey():
		// A retry of the same action. Replaying it is exactly what the
		// idempotency key is for.
		return &alertsv1.RespondToAlertResponse{AlertId: req.GetAlertId(), Recorded: false}, nil
	case answered:
		return nil, status.Errorf(codes.Aborted,
			"alert %s was already answered", req.GetAlertId())
	case !live:
		return nil, status.Errorf(codes.FailedPrecondition,
			"alert %s is no longer active", req.GetAlertId())
	}

	if req.GetOutcome() == alertsv1.AlertOutcome_ALERT_OUTCOME_ANSWERED && !hasButton(alert, req.GetButtonId()) {
		return nil, fieldViolation("button_id",
			fmt.Sprintf("%q is not a button on this alert", req.GetButtonId()))
	}

	// A dismissal is reported but leaves the alert outstanding: the user closed
	// the notification, they did not answer it (design section 7.4).
	if req.GetOutcome() == alertsv1.AlertOutcome_ALERT_OUTCOME_ANSWERED {
		s.responses[req.GetAlertId()] = req
		delete(s.pending, req.GetAlertId())
	}
	return &alertsv1.RespondToAlertResponse{AlertId: req.GetAlertId(), Recorded: true}, nil
}

func (s *server) GetMachineConfig(ctx context.Context, req *alertsv1.GetMachineConfigRequest) (*alertsv1.GetMachineConfigResponse, error) {
	if err := s.authorize(ctx, req.GetClientId()); err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	response := &alertsv1.GetMachineConfigResponse{
		Version:  s.versionString(req.GetClientId()),
		GpuTypes: gpuTypes,
		Limits:   limits,
	}
	if current, ok := s.config[req.GetClientId()]; ok {
		response.Current = current
	}
	if change, ok := s.pendingChange[req.GetClientId()]; ok {
		response.PendingChange = change
	}
	return response, nil
}

func (s *server) PreviewMachineConfig(ctx context.Context, req *alertsv1.PreviewMachineConfigRequest) (*alertsv1.PreviewMachineConfigResponse, error) {
	if err := s.authorize(ctx, req.GetClientId()); err != nil {
		return nil, err
	}
	if err := validateSpec(req.GetSpec()); err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.config[req.GetClientId()]
	effects := diff(current, req.GetSpec())

	restart := false
	for _, effect := range effects {
		if effect.GetRequiresRestart() {
			restart = true
		}
	}
	response := &alertsv1.PreviewMachineConfigResponse{
		HasChanges:                len(effects) > 0,
		RequiresRestart:           restart,
		Effects:                   effects,
		CancellationWindowSeconds: uint32(cancelWindow.Seconds()),
	}
	if restart {
		response.Warning = "Running jobs will be terminated."
	}
	return response, nil
}

func (s *server) ApplyMachineConfig(ctx context.Context, req *alertsv1.ApplyMachineConfigRequest) (*alertsv1.ApplyMachineConfigResponse, error) {
	if err := s.authorize(ctx, req.GetClientId()); err != nil {
		return nil, err
	}
	if err := validateSpec(req.GetSpec()); err != nil {
		return nil, err
	}

	s.mu.Lock()
	if expected := req.GetExpectedVersion(); expected != "" && expected != s.versionString(req.GetClientId()) {
		s.mu.Unlock()
		// The form was built from a configuration that has since changed.
		// Applying it would silently revert whoever changed it.
		return nil, status.Errorf(codes.Aborted,
			"machine was changed elsewhere; expected version %s", s.versionString(req.GetClientId()))
	}
	if existing, ok := s.pendingChange[req.GetClientId()]; ok {
		s.mu.Unlock()
		return nil, status.Errorf(codes.FailedPrecondition,
			"change %s is already being applied", existing.GetChangeId())
	}

	now := s.clock()
	change := &alertsv1.MachineChange{
		ChangeId:         fmt.Sprintf("chg_%d", s.sequence+1),
		Status:           alertsv1.ChangeStatus_CHANGE_STATUS_APPLYING,
		Spec:             req.GetSpec(),
		StartedAt:        timestamppb.New(now),
		CancellableUntil: timestamppb.New(now.Add(cancelWindow)),
	}
	s.pendingChange[req.GetClientId()] = change
	s.mu.Unlock()

	if s.applyDelay == 0 {
		s.completeChange(req.GetClientId(), change.GetChangeId())
	} else {
		time.AfterFunc(s.applyDelay, func() {
			s.completeChange(req.GetClientId(), change.GetChangeId())
		})
	}

	return &alertsv1.ApplyMachineConfigResponse{
		Change:     change,
		ServerTime: timestamppb.New(now),
	}, nil
}

func (s *server) CancelMachineChange(ctx context.Context, req *alertsv1.CancelMachineChangeRequest) (*alertsv1.CancelMachineChangeResponse, error) {
	if err := s.authorize(ctx, req.GetClientId()); err != nil {
		return nil, err
	}

	s.mu.Lock()
	change, ok := s.pendingChange[req.GetClientId()]
	if !ok || change.GetChangeId() != req.GetChangeId() {
		s.mu.Unlock()
		return nil, status.Errorf(codes.FailedPrecondition,
			"change %s is not in progress", req.GetChangeId())
	}
	if until := change.GetCancellableUntil(); until != nil && s.clock().After(until.AsTime()) {
		s.mu.Unlock()
		// The client renders a countdown, but the server decides. Losing this
		// race is a normal outcome, not an error to surface as a failure.
		return nil, status.Errorf(codes.FailedPrecondition,
			"change %s is past its cancellation window", req.GetChangeId())
	}

	// Cancelling reverts: the machine keeps its previous configuration, so
	// there is no partial state for the client to represent.
	cancelled := &alertsv1.MachineChange{
		ChangeId:  change.GetChangeId(),
		Status:    alertsv1.ChangeStatus_CHANGE_STATUS_CANCELLED,
		Spec:      change.GetSpec(),
		StartedAt: change.GetStartedAt(),
	}
	delete(s.pendingChange, req.GetClientId())
	event := s.machineChangedLocked(req.GetClientId(), cancelled)
	s.mu.Unlock()

	s.publish(event)
	return &alertsv1.CancelMachineChangeResponse{Change: cancelled}, nil
}

func (s *server) completeChange(clientID, changeID string) {
	s.mu.Lock()
	change, ok := s.pendingChange[clientID]
	if !ok || change.GetChangeId() != changeID {
		s.mu.Unlock()
		return
	}
	s.config[clientID] = change.GetSpec()
	s.configVersion[clientID]++
	applied := &alertsv1.MachineChange{
		ChangeId:  change.GetChangeId(),
		Status:    alertsv1.ChangeStatus_CHANGE_STATUS_APPLIED,
		Spec:      change.GetSpec(),
		StartedAt: change.GetStartedAt(),
	}
	delete(s.pendingChange, clientID)
	event := s.machineChangedLocked(clientID, applied)
	s.mu.Unlock()

	s.publish(event)
}

// ---------------------------------------------------------------------------
// Event plumbing
// ---------------------------------------------------------------------------

func (s *server) subscribe(after uint64) ([]*alertsv1.Event, <-chan *alertsv1.Event, <-chan struct{}, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()

	backlog := make([]*alertsv1.Event, 0, len(s.events))
	for _, event := range s.events {
		if event.GetSequence() > after {
			backlog = append(backlog, event)
		}
	}

	id := s.nextSub
	s.nextSub++
	channel := make(chan *alertsv1.Event, 64)
	drop := make(chan struct{})
	s.subscribers[id] = channel
	s.drops[id] = drop

	return backlog, channel, drop, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.subscribers, id)
		delete(s.drops, id)
		close(channel)
	}
}

// liveStreams reports how many streams are connected, so a test can wait for a
// client to reconnect rather than guessing at a delay.
func (s *server) liveStreams() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.drops)
}

// dropAll cuts every live stream. The event log is untouched, so reconnecting
// clients replay from last_sequence exactly as they would after a real network
// interruption.
func (s *server) dropAll() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for id, drop := range s.drops {
		close(drop)
		delete(s.drops, id)
		count++
	}
	return count
}

// appendLocked assigns the next sequence and records the event. The caller
// publishes it after releasing the lock.
func (s *server) appendLocked(payload func(sequence uint64) *alertsv1.Event) *alertsv1.Event {
	s.sequence++
	event := payload(s.sequence)
	s.events = append(s.events, event)
	return event
}

func (s *server) publish(event *alertsv1.Event) {
	s.mu.Lock()
	subscribers := make([]chan *alertsv1.Event, 0, len(s.subscribers))
	for _, channel := range s.subscribers {
		subscribers = append(subscribers, channel)
	}
	s.mu.Unlock()

	for _, channel := range subscribers {
		select {
		case channel <- event:
		default:
			// A subscriber that cannot keep up is dropped rather than blocking
			// the publisher; it recovers on reconnect via last_sequence.
		}
	}
}

func (s *server) heartbeat() *alertsv1.Event {
	return &alertsv1.Event{
		Payload: &alertsv1.Event_Heartbeat{
			Heartbeat: &alertsv1.Heartbeat{ServerTime: timestamppb.New(s.clock())},
		},
	}
}

func (s *server) machineChangedLocked(clientID string, change *alertsv1.MachineChange) *alertsv1.Event {
	return s.appendLocked(func(sequence uint64) *alertsv1.Event {
		return &alertsv1.Event{
			Sequence: sequence,
			Payload: &alertsv1.Event_MachineConfigChanged{
				MachineConfigChanged: &alertsv1.MachineConfigChanged{
					Current: s.config[clientID],
					Version: s.versionString(clientID),
					Change:  change,
				},
			},
		}
	})
}

// pushAlert makes an alert available to subscribers. Used by the admin CLI.
func (s *server) pushAlert(alert *alertsv1.Alert) *alertsv1.Event {
	s.mu.Lock()
	s.pending[alert.GetAlertId()] = alert
	event := s.appendLocked(func(sequence uint64) *alertsv1.Event {
		return &alertsv1.Event{
			Sequence: sequence,
			Payload:  &alertsv1.Event_Alert{Alert: alert},
		}
	})
	s.mu.Unlock()

	s.publish(event)
	return event
}

func (s *server) revokeAlert(alertID, reason string) error {
	s.mu.Lock()
	if _, ok := s.pending[alertID]; !ok {
		s.mu.Unlock()
		return errors.New("no such pending alert")
	}
	delete(s.pending, alertID)
	event := s.appendLocked(func(sequence uint64) *alertsv1.Event {
		return &alertsv1.Event{
			Sequence: sequence,
			Payload: &alertsv1.Event_AlertRevoked{
				AlertRevoked: &alertsv1.AlertRevoked{AlertId: alertID, Reason: reason},
			},
		}
	})
	s.mu.Unlock()

	s.publish(event)
	return nil
}

func (s *server) versionString(clientID string) string {
	return fmt.Sprintf("v%d", s.configVersion[clientID])
}

// ---------------------------------------------------------------------------
// Validation and diffing
// ---------------------------------------------------------------------------

func validateSpec(spec *alertsv1.ResourceSpec) error {
	if spec == nil {
		return fieldViolation("spec", "spec is required")
	}

	gpu := findGPU(spec.GetGpuTypeId())
	if gpu == nil {
		return fieldViolation("spec.gpu_type_id",
			fmt.Sprintf("%q is not an available GPU type", spec.GetGpuTypeId()))
	}

	switch {
	case spec.GetGpuTypeId() == noneGPU && spec.GpuCount != nil:
		// Strict on purpose: a client bug in the conditional logic should
		// surface here rather than quietly provisioning the wrong thing.
		return fieldViolation("spec.gpu_count", "gpu_count must be absent when gpu_type_id is \"none\"")
	case spec.GetGpuTypeId() != noneGPU && spec.GpuCount == nil:
		return fieldViolation("spec.gpu_count", "gpu_count is required for this GPU type")
	case spec.GpuCount != nil && (spec.GetGpuCount() < limits.GetGpuCountMin() || spec.GetGpuCount() > gpu.GetMaxCount()):
		return fieldViolation("spec.gpu_count",
			fmt.Sprintf("gpu_count must be between %d and %d for %s",
				limits.GetGpuCountMin(), gpu.GetMaxCount(), gpu.GetLabel()))
	}

	for _, check := range []struct {
		path       string
		value      uint32
		min, max   uint32
		unitSuffix string
	}{
		{"spec.cpu_cores", spec.GetCpuCores(), limits.GetCpuCoresMin(), limits.GetCpuCoresMax(), ""},
		{"spec.ram_gb", spec.GetRamGb(), limits.GetRamGbMin(), limits.GetRamGbMax(), " GB"},
		{"spec.ssd_gb", spec.GetSsdGb(), limits.GetSsdGbMin(), limits.GetSsdGbMax(), " GB"},
	} {
		if check.value < check.min || check.value > check.max {
			return fieldViolation(check.path, fmt.Sprintf("must be between %d%s and %d%s",
				check.min, check.unitSuffix, check.max, check.unitSuffix))
		}
	}
	return nil
}

// diff reports one ChangeEffect per changed field. Only GPU changes require a
// restart, which is the whole reason the client asks rather than guessing.
func diff(current, next *alertsv1.ResourceSpec) []*alertsv1.ChangeEffect {
	if current == nil {
		return []*alertsv1.ChangeEffect{{
			FieldPath:       "spec",
			Description:     "Initial configuration",
			RequiresRestart: true,
		}}
	}

	var effects []*alertsv1.ChangeEffect
	if current.GetGpuTypeId() != next.GetGpuTypeId() || current.GetGpuCount() != next.GetGpuCount() {
		effects = append(effects, &alertsv1.ChangeEffect{
			FieldPath:       "spec.gpu_type_id",
			Description:     "Requires a restart",
			RequiresRestart: true,
		})
	}
	for _, field := range []struct {
		path          string
		before, after uint32
	}{
		{"spec.cpu_cores", current.GetCpuCores(), next.GetCpuCores()},
		{"spec.ram_gb", current.GetRamGb(), next.GetRamGb()},
		{"spec.ssd_gb", current.GetSsdGb(), next.GetSsdGb()},
	} {
		if field.before != field.after {
			effects = append(effects, &alertsv1.ChangeEffect{
				FieldPath:       field.path,
				Description:     "Applied without a restart",
				RequiresRestart: false,
			})
		}
	}
	return effects
}

// fieldViolation builds the INVALID_ARGUMENT + google.rpc.BadRequest pair the
// client maps back onto form inputs by proto path.
func fieldViolation(path, description string) error {
	st := status.New(codes.InvalidArgument, description)
	detailed, err := st.WithDetails(&errdetails.BadRequest{
		FieldViolations: []*errdetails.BadRequest_FieldViolation{
			{Field: path, Description: description},
		},
	})
	if err != nil {
		return st.Err()
	}
	return detailed.Err()
}

func findGPU(id string) *alertsv1.GpuType {
	for _, gpu := range gpuTypes {
		if gpu.GetGpuTypeId() == id {
			return gpu
		}
	}
	return nil
}

func hasButton(alert *alertsv1.Alert, buttonID string) bool {
	for _, button := range alert.GetButtons() {
		if button.GetButtonId() == buttonID {
			return true
		}
	}
	return false
}

func ptr[T any](value T) *T { return &value }
