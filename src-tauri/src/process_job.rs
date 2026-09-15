//! Windows-only: assigns this process to a job with `KILL_ON_JOB_CLOSE`, so a crash or
//! kill of Kriti itself brings down every FFmpeg child still running with it — never an
//! orphaned encoder (docs/MEDIA-PIPELINE.md §1.2). Child processes join their parent's
//! job by default on Windows, so nothing extra is needed per FFmpeg invocation.
//!
//! Uses `win32job`, a safe wrapper, so this crate's `unsafe_code = "deny"` (Cargo.toml)
//! holds everywhere, including here.

use crate::error::AppError;

pub fn create() -> Result<win32job::Job, AppError> {
    let job = win32job::Job::create()
        .map_err(|e| AppError::internal(format!("creating the process job: {e}")))?;
    let mut info = job
        .query_extended_limit_info()
        .map_err(|e| AppError::internal(format!("reading the process job's limits: {e}")))?;
    info.limit_kill_on_job_close();
    job.set_extended_limit_info(&info)
        .map_err(|e| AppError::internal(format!("setting the process job's limits: {e}")))?;
    job.assign_current_process()
        .map_err(|e| AppError::internal(format!("assigning this process to the job: {e}")))?;
    Ok(job)
}
