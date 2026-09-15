//! Background job scheduling: bounded concurrency per resource class, cancellation, and
//! coarse status events to the UI (docs/ARCHITECTURE.md §6.1, docs/MEDIA-PIPELINE.md §7).
//!
//! Fine-grained progress (a percentage) is not implemented yet: nothing in Phase 3 needs
//! more than "it's running" / "it finished" / "it failed". Parsing FFmpeg's `-progress`
//! output for real progress is added when export (Phase 6) needs it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Wry};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::{AppError, ErrorCode};

/// Caps concurrency independently per class, so a long `heavy` job never starves the
/// `probe`/`light` jobs that make the UI feel alive (docs/MEDIA-PIPELINE.md §6.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceClass {
    Probe,
    Light,
    Heavy,
}

impl ResourceClass {
    fn concurrency(self) -> usize {
        match self {
            Self::Probe => 4,
            Self::Light => 2,
            Self::Heavy => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatusEvent {
    pub job_id: String,
    pub kind: String,
    pub state: JobState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppError>,
}

pub struct JobScheduler {
    app: AppHandle<Wry>,
    probe: Arc<Semaphore>,
    light: Arc<Semaphore>,
    heavy: Arc<Semaphore>,
    jobs: Mutex<HashMap<String, CancellationToken>>,
}

impl JobScheduler {
    pub fn new(app: AppHandle<Wry>) -> Self {
        Self {
            app,
            probe: Arc::new(Semaphore::new(ResourceClass::Probe.concurrency())),
            light: Arc::new(Semaphore::new(ResourceClass::Light.concurrency())),
            heavy: Arc::new(Semaphore::new(ResourceClass::Heavy.concurrency())),
            jobs: Mutex::new(HashMap::new()),
        }
    }

    fn semaphore(&self, class: ResourceClass) -> &Arc<Semaphore> {
        match class {
            ResourceClass::Probe => &self.probe,
            ResourceClass::Light => &self.light,
            ResourceClass::Heavy => &self.heavy,
        }
    }

    /// Waits for a free slot in `class`. The permit must be held for the job's duration.
    pub async fn acquire(&self, class: ResourceClass) -> OwnedSemaphorePermit {
        let semaphore = self.semaphore(class).clone();
        #[allow(clippy::unwrap_used)] // a Semaphore that is never closed cannot return Err here
        semaphore.acquire_owned().await.unwrap()
    }

    /// Registers a new job, emits its `running` status, and returns its id plus a
    /// cancellation token to thread through the actual work (e.g. into `ffmpeg::probe`).
    pub fn begin_job(&self, kind: &str) -> (String, CancellationToken) {
        let job_id = Uuid::new_v4().to_string();
        let token = CancellationToken::new();
        self.lock_jobs().insert(job_id.clone(), token.clone());
        self.emit(&job_id, kind, JobState::Running, None);
        (job_id, token)
    }

    /// Emits the job's final status and forgets it (a cancelled-but-unknown job id is a
    /// normal "already finished" outcome for `cancel_job`, not an error condition).
    pub fn finish_job(&self, job_id: &str, kind: &str, result: &Result<(), AppError>) {
        self.lock_jobs().remove(job_id);
        let state = match result {
            Ok(()) => JobState::Succeeded,
            Err(error) if error.code == ErrorCode::Cancelled => JobState::Cancelled,
            Err(_) => JobState::Failed,
        };
        self.emit(job_id, kind, state, result.as_ref().err().cloned());
    }

    /// Requests cancellation of a running job. Returns `false` if no job with this id is
    /// currently running (already finished, or never existed) — not an error.
    pub fn cancel_job(&self, job_id: &str) -> bool {
        match self.lock_jobs().get(job_id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    fn lock_jobs(&self) -> std::sync::MutexGuard<'_, HashMap<String, CancellationToken>> {
        self.jobs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn emit(&self, job_id: &str, kind: &str, state: JobState, error: Option<AppError>) {
        let event = JobStatusEvent {
            job_id: job_id.to_owned(),
            kind: kind.to_owned(),
            state,
            error,
        };
        if let Err(emit_error) = self.app.emit("job:status", &event) {
            tracing::warn!(error = %emit_error, "could not emit job:status");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_class_concurrency_matches_the_documented_limits() {
        assert_eq!(ResourceClass::Probe.concurrency(), 4);
        assert_eq!(ResourceClass::Light.concurrency(), 2);
        assert_eq!(ResourceClass::Heavy.concurrency(), 1);
    }

    #[tokio::test]
    async fn heavy_jobs_serialize_through_a_single_permit() {
        let semaphore = Arc::new(Semaphore::new(ResourceClass::Heavy.concurrency()));
        let first = semaphore.clone().acquire_owned().await.unwrap();
        assert_eq!(semaphore.available_permits(), 0);
        drop(first);
        assert_eq!(semaphore.available_permits(), 1);
    }
}
