use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use dashboardd_widget_protocol::InstanceId;
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::broadcast;
use utoipa::ToSchema;

use crate::{event::DashboardEvent, state::DashboardId};

pub const PROBE_INTERVAL: Duration = Duration::from_secs(10);
pub const STALE_AFTER: Duration = Duration::from_secs(30);
const MAX_ERROR_CODE_BYTES: usize = 64;
const MAX_ERROR_MESSAGE_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    Starting,
    Healthy,
    Stale,
    Degraded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct HealthError {
    pub code: String,
    pub message: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct InstanceHealth {
    pub instance_id: InstanceId,
    pub status: HealthStatus,
    pub started_at: String,
    pub last_update_at: Option<String>,
    pub last_error: Option<HealthError>,
    pub restart_count: u64,
}

#[derive(Clone)]
pub struct HealthTracker {
    dashboard_id: DashboardId,
    state: Arc<Mutex<HealthState>>,
    events: broadcast::Sender<DashboardEvent>,
}

struct HealthState {
    public: InstanceHealth,
    launched: Instant,
    last_activity: Instant,
    ready: bool,
    degraded: bool,
}

impl HealthTracker {
    pub fn new(
        dashboard_id: DashboardId,
        instance_id: InstanceId,
        events: broadcast::Sender<DashboardEvent>,
    ) -> Self {
        let now = Instant::now();
        Self {
            dashboard_id,
            state: Arc::new(Mutex::new(HealthState {
                public: InstanceHealth {
                    instance_id,
                    status: HealthStatus::Starting,
                    started_at: timestamp(),
                    last_update_at: None,
                    last_error: None,
                    restart_count: 0,
                },
                launched: now,
                last_activity: now,
                ready: false,
                degraded: false,
            })),
            events,
        }
    }

    pub fn snapshot(&self) -> InstanceHealth {
        self.state
            .lock()
            .expect("health lock is poisoned")
            .public
            .clone()
    }

    pub fn publish(&self) {
        self.emit(self.snapshot());
    }

    pub fn ready(&self) {
        self.change(|state, now| {
            state.ready = true;
            state.last_activity = now;
            state.public.status = if state.degraded {
                HealthStatus::Degraded
            } else {
                HealthStatus::Healthy
            };
        });
    }

    pub fn update(&self) {
        self.change(|state, now| {
            state.last_activity = now;
            state.degraded = false;
            state.public.status = HealthStatus::Healthy;
            state.public.last_update_at = Some(timestamp());
        });
    }

    pub fn activity(&self) {
        self.change(|state, now| {
            state.last_activity = now;
            if state.public.status == HealthStatus::Stale && state.ready {
                state.public.status = if state.degraded {
                    HealthStatus::Degraded
                } else {
                    HealthStatus::Healthy
                };
            }
        });
    }

    pub fn reported_error(&self, code: &str, message: &str) {
        self.change(|state, now| {
            state.last_activity = now;
            state.degraded = true;
            state.public.status = HealthStatus::Degraded;
            state.public.last_error = Some(HealthError {
                code: truncate(code, MAX_ERROR_CODE_BYTES),
                message: truncate(message, MAX_ERROR_MESSAGE_BYTES),
                at: timestamp(),
            });
        });
    }

    pub fn failed(&self) {
        self.change(|state, _| {
            state.public.status = HealthStatus::Failed;
            state.public.last_error = Some(HealthError {
                code: "backend_failed".into(),
                message: "Widget backend exited unexpectedly".into(),
                at: timestamp(),
            });
        });
    }

    pub fn restarted(&self) {
        self.change(|state, now| {
            state.public.status = HealthStatus::Starting;
            state.public.started_at = timestamp();
            state.public.last_update_at = None;
            state.public.restart_count = state.public.restart_count.saturating_add(1);
            state.launched = now;
            state.last_activity = now;
            state.ready = false;
            state.degraded = false;
        });
    }

    pub fn check_stale(&self) {
        self.check_stale_at(Instant::now());
    }

    fn check_stale_at(&self, now: Instant) {
        self.change_at(now, |state, now| {
            if state.public.status == HealthStatus::Failed {
                return;
            }
            let elapsed = if state.ready {
                now.saturating_duration_since(state.last_activity)
            } else {
                now.saturating_duration_since(state.launched)
            };
            if elapsed >= STALE_AFTER {
                state.public.status = HealthStatus::Stale;
            }
        });
    }

    fn change(&self, update: impl FnOnce(&mut HealthState, Instant)) {
        self.change_at(Instant::now(), update);
    }

    fn change_at(&self, now: Instant, update: impl FnOnce(&mut HealthState, Instant)) {
        let changed = {
            let mut state = self.state.lock().expect("health lock is poisoned");
            let previous = state.public.clone();
            update(&mut state, now);
            (state.public != previous).then(|| state.public.clone())
        };
        if let Some(health) = changed {
            self.emit(health);
        }
    }

    fn emit(&self, health: InstanceHealth) {
        let _ = self.events.send(DashboardEvent::InstanceHealthUpdated {
            dashboard_id: self.dashboard_id.clone(),
            health,
        });
    }
}

fn timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("RFC 3339 formatting is valid")
}

fn truncate(value: &str, maximum_bytes: usize) -> String {
    if value.len() <= maximum_bytes {
        return value.into();
    }
    let mut end = maximum_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_lifecycle_staleness_recovery_and_restarts() {
        let (events, _) = broadcast::channel(16);
        let tracker = HealthTracker::new("dashboard-1".into(), "cpu-1".into(), events);
        let launched = tracker.state.lock().unwrap().launched;

        tracker.check_stale_at(launched + STALE_AFTER);
        assert_eq!(tracker.snapshot().status, HealthStatus::Stale);
        tracker.activity();
        assert_eq!(tracker.snapshot().status, HealthStatus::Stale);
        tracker.ready();
        assert_eq!(tracker.snapshot().status, HealthStatus::Healthy);
        tracker.reported_error("provider", "temporarily unavailable");
        assert_eq!(tracker.snapshot().status, HealthStatus::Degraded);
        tracker.activity();
        assert_eq!(tracker.snapshot().status, HealthStatus::Degraded);
        tracker.update();
        assert_eq!(tracker.snapshot().status, HealthStatus::Healthy);
        tracker.restarted();

        let health = tracker.snapshot();
        assert_eq!(health.status, HealthStatus::Starting);
        assert_eq!(health.restart_count, 1);
        assert!(health.last_update_at.is_none());
        assert_eq!(health.last_error.unwrap().code, "provider");
    }

    #[test]
    fn truncates_public_errors_without_splitting_utf8() {
        let (events, _) = broadcast::channel(4);
        let tracker = HealthTracker::new("dashboard-1".into(), "cpu-1".into(), events);
        let message = "a".repeat(511) + "€";
        tracker.reported_error(&"c".repeat(80), &message);

        let error = tracker.snapshot().last_error.unwrap();
        assert_eq!(error.code.len(), MAX_ERROR_CODE_BYTES);
        assert_eq!(error.message.len(), 511);
        assert!(error.message.ends_with('a'));
    }
}
