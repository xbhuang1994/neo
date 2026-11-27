#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

fn parse_launcher_args<I: IntoIterator<Item = OsString>>(
    args: I,
) -> (Option<PathBuf>, Vec<OsString>) {
    let mut log_file: Option<PathBuf> = None;
    let mut forwarded = Vec::new();
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg == "--log-file" {
            if let Some(val) = iter.next() {
                log_file = Some(PathBuf::from(val));
            }
            continue;
        }
        if let Some(s) = arg.to_str() {
            if let Some(rest) = s.strip_prefix("--log-file=") {
                if !rest.is_empty() {
                    log_file = Some(PathBuf::from(rest));
                }
                continue;
            }
        }
        forwarded.push(arg);
    }
    (log_file, forwarded)
}

fn sibling_agent_binary(current_exe: &Path) -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "neo-agent-os.exe"
    } else {
        "neo-agent-os"
    };
    current_exe
        .parent()
        .map(|dir| dir.join(name))
        .unwrap_or_else(|| PathBuf::from(name))
}

#[cfg(target_os = "windows")]
mod win_job {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    type Handle = *mut c_void;

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: u32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

    #[repr(C)]
    #[derive(Default)]
    struct JobObjectBasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct JobObjectExtendedLimitInformation {
        basic_limit_information: JobObjectBasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    extern "system" {
        fn CreateJobObjectW(lp_job_attributes: *mut c_void, lp_name: *const u16) -> Handle;
        fn SetInformationJobObject(
            h_job: Handle,
            job_object_information_class: u32,
            lp_job_object_information: *const c_void,
            cb_job_object_information_length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(h_job: Handle, h_process: Handle) -> i32;
        fn CloseHandle(h_object: Handle) -> i32;
    }

    pub struct KillOnCloseJob(Handle);

    impl KillOnCloseJob {
        pub fn attach(child: &Child) -> Option<Self> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut info = JobObjectExtendedLimitInformation::default();
                info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                    (&info as *const JobObjectExtendedLimitInformation).cast::<c_void>(),
                    std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
                );
                if ok == 0 {
                    let _ = CloseHandle(job);
                    return None;
                }
                let assigned = AssignProcessToJobObject(job, child.as_raw_handle().cast::<c_void>());
                if assigned == 0 {
                    let _ = CloseHandle(job);
                    return None;
                }
                Some(Self(job))
            }
        }
    }

    impl Drop for KillOnCloseJob {
        fn drop(&mut self) {
            unsafe {
                if !self.0.is_null() {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }
}

fn open_log_stdio(log_file: Option<&Path>) -> (Stdio, Stdio) {
    if let Some(path) = log_file {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(out_file) = OpenOptions::new().create(true).append(true).open(path) {
            if let Ok(err_file) = out_file.try_clone() {
                return (Stdio::from(out_file), Stdio::from(err_file));
            }
            return (Stdio::from(out_file), Stdio::null());
        }
    }
    (Stdio::null(), Stdio::null())
}

fn main() -> ExitCode {
    let (log_file, forwarded) = parse_launcher_args(std::env::args_os().skip(1));
    let current_exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return ExitCode::from(1),
    };
    let target_bin = sibling_agent_binary(&current_exe);
    let (stdout, stderr) = open_log_stdio(log_file.as_deref());

    let mut cmd = Command::new(&target_bin);
    cmd.args(&forwarded)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return ExitCode::from(1),
    };

    #[cfg(target_os = "windows")]
    let _job = win_job::KillOnCloseJob::attach(&child);

    match child.wait() {
        Ok(status) => match status.code() {
            Some(code) if (0..=255).contains(&code) => ExitCode::from(code as u8),
            Some(_) => ExitCode::from(1),
            None => ExitCode::SUCCESS,
        },
        Err(_) => ExitCode::from(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_file_and_preserves_forwarded_args() {
        let raw = vec![
            OsString::from("--log-file"),
            OsString::from("C:\\neo\\logs\\agent.log"),
            OsString::from("--env-file"),
            OsString::from("C:\\neo\\cluster.env"),
            OsString::from("--policy"),
            OsString::from("C:\\neo\\policy.toml"),
        ];
        let (log, forwarded) = parse_launcher_args(raw);
        assert_eq!(log, Some(PathBuf::from("C:\\neo\\logs\\agent.log")));
        assert_eq!(
            forwarded,
            vec![
                OsString::from("--env-file"),
                OsString::from("C:\\neo\\cluster.env"),
                OsString::from("--policy"),
                OsString::from("C:\\neo\\policy.toml"),
            ]
        );

        let raw_eq = vec![
            OsString::from("--log-file=/tmp/a.log"),
            OsString::from("--one-shot-check"),
        ];
        let (log2, fwd2) = parse_launcher_args(raw_eq);
        assert_eq!(log2, Some(PathBuf::from("/tmp/a.log")));
        assert_eq!(fwd2, vec![OsString::from("--one-shot-check")]);
    }
}
