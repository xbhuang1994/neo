//! What the operating system says about processes: enough for the Watchdog to tell work in progress from a hang.
//!
//! Linux reads `/proc`. Other systems ask their own tools once per sample: `ps` and `lsof` on macOS and other Unix,
//! PowerShell's process table on Windows, where a process's working directory is not available. Only standard-library
//! code is used, so every parser builds and is tested on every platform.

use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::process::{Command, Stdio};

/// One process, as sampled.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProcessSnapshot {
    /// Its id.
    pub pid: u32,
    /// Its parent's id.
    pub ppid: u32,
    /// Its scheduler state as the system names it, such as `R` or `S`; `?` when unknown.
    pub state: String,
    /// The CPU time it has used, in units that only grow: a later sample that is larger means it worked.
    pub cpu_ticks: u64,
    /// Its command line.
    pub cmd: String,
}

/// The most processes one tree is followed to.
const MAX_TREE: usize = 128;
const CMD_CHARS: usize = 180;

fn clip(text: &str) -> String {
    text.chars().take(CMD_CHARS).collect()
}

/// `roots` and every process they started, as far as [`MAX_TREE`] processes.
pub fn tree(roots: &[u32]) -> Vec<ProcessSnapshot> {
    if roots.is_empty() {
        return Vec::new();
    }
    if cfg!(target_os = "linux") {
        return linux::descendants(roots).into_iter().filter_map(linux::snapshot).collect();
    }
    table_tree(roots, &table())
}

/// The processes of this user whose working directory is `directory` or inside it; empty where the system cannot say.
pub fn in_directory(directory: &Path) -> Vec<u32> {
    if cfg!(target_os = "linux") {
        linux::in_directory(directory)
    } else if cfg!(windows) {
        Vec::new()
    } else {
        run("lsof", &["-a", "-d", "cwd", "-F", "pn"]).map(|output| parse_lsof(&output, directory)).unwrap_or_default()
    }
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    // `lsof` exits non-zero when some process cannot be read, and still lists the rest.
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Every process the system lists, from its own tools.
fn table() -> Vec<ProcessSnapshot> {
    if cfg!(windows) {
        let script = "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.KernelModeTime + $_.UserModeTime)`t$($_.Name)`t$($_.CommandLine)\" }";
        run("powershell", &["-NoProfile", "-NonInteractive", "-Command", script]).map(|output| parse_windows(&output)).unwrap_or_default()
    } else {
        run("ps", &["-axo", "pid=,ppid=,state=,time=,command="]).map(|output| parse_ps(&output)).unwrap_or_default()
    }
}

/// `roots` and their descendants within a process table.
fn table_tree(roots: &[u32], table: &[ProcessSnapshot]) -> Vec<ProcessSnapshot> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for process in table {
        children.entry(process.ppid).or_default().push(process.pid);
    }
    let mut visited: Vec<u32> = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut queue: VecDeque<u32> = roots.iter().copied().collect();
    while let Some(pid) = queue.pop_front() {
        if visited.len() >= MAX_TREE {
            break;
        }
        if pid == 0 || !seen.insert(pid) {
            continue;
        }
        visited.push(pid);
        queue.extend(children.get(&pid).into_iter().flatten().copied());
    }
    visited.into_iter().filter_map(|pid| table.iter().find(|process| process.pid == pid).cloned()).collect()
}

/// A CPU time such as `1:23.45`, `00:01:23` or `2-03:04:05` in hundredths of a second.
fn cpu_time(text: &str) -> u64 {
    let (days, clock) = match text.split_once('-') {
        Some((days, clock)) => (days.parse::<u64>().unwrap_or(0), clock),
        None => (0, text),
    };
    let mut hundredths = 0u64;
    let mut seconds = 0u64;
    for part in clock.split(':') {
        let (whole, fraction) = part.split_once('.').unwrap_or((part, ""));
        seconds = seconds * 60 + whole.parse::<u64>().unwrap_or(0);
        let digits: String = fraction.chars().chain("00".chars()).take(2).collect();
        hundredths = digits.parse().unwrap_or(0);
    }
    (days * 86_400 + seconds) * 100 + hundredths
}

/// The lines of `ps -axo pid=,ppid=,state=,time=,command=`.
fn parse_ps(output: &str) -> Vec<ProcessSnapshot> {
    output
        .lines()
        .filter_map(|line| {
            let mut rest = line.trim_start();
            let mut field = || {
                let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
                let (value, tail) = rest.split_at(end);
                rest = tail.trim_start();
                value
            };
            let (pid, ppid, state, time) = (field().parse().ok()?, field().parse().ok()?, field().to_string(), field().to_string());
            Some(ProcessSnapshot { pid, ppid, state, cpu_ticks: cpu_time(&time), cmd: clip(rest.trim_end()) })
        })
        .collect()
}

/// The processes whose working directory, in `lsof -a -d cwd -F pn` output, is `directory` or inside it.
fn parse_lsof(output: &str, directory: &Path) -> Vec<u32> {
    let own = std::process::id();
    let mut found = Vec::new();
    let mut pid: Option<u32> = None;
    for line in output.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse().ok();
        } else if let (Some(path), Some(current)) = (line.strip_prefix('n'), pid) {
            if current != own && Path::new(path).starts_with(directory) && !found.contains(&current) {
                found.push(current);
            }
        }
    }
    found
}

/// The lines PowerShell prints for the Windows process table: id, parent id, CPU time in 100 ns, name, command line.
fn parse_windows(output: &str) -> Vec<ProcessSnapshot> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.trim_end_matches('\r').splitn(5, '\t');
            let (pid, ppid, time, name) = (fields.next()?.trim().parse().ok()?, fields.next()?.trim().parse().ok()?, fields.next()?, fields.next()?);
            let command = fields.next().map(str::trim).filter(|command| !command.is_empty()).unwrap_or(name);
            Some(ProcessSnapshot { pid, ppid, state: "?".into(), cpu_ticks: time.trim().parse::<u64>().unwrap_or(0) / 100_000, cmd: clip(command) })
        })
        .collect()
}

mod linux {
    use super::{clip, ProcessSnapshot, MAX_TREE};
    use std::collections::{HashSet, VecDeque};
    use std::path::Path;

    /// One process from `/proc/<pid>/stat` and `cmdline`.
    pub fn snapshot(pid: u32) -> Option<ProcessSnapshot> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // The command name is in parentheses and may itself hold spaces or parentheses.
        let end = stat.rfind(')')?;
        let fields: Vec<&str> = stat.get(end + 2..)?.split_whitespace().collect();
        let number = |index: usize| fields.get(index).and_then(|value| value.parse::<u64>().ok()).unwrap_or(0);
        let command =
            std::fs::read(format!("/proc/{pid}/cmdline")).map(|raw| String::from_utf8_lossy(&raw).replace('\0', " ").trim().to_string()).unwrap_or_default();
        let name = stat.get(stat.find('(')? + 1..end).unwrap_or("");
        Some(ProcessSnapshot {
            pid,
            ppid: number(1) as u32,
            state: fields.first().unwrap_or(&"?").to_string(),
            cpu_ticks: number(11) + number(12),
            cmd: clip(if command.is_empty() { name } else { &command }),
        })
    }

    /// `roots` and the processes they started, through each thread's `children` list.
    pub fn descendants(roots: &[u32]) -> Vec<u32> {
        let mut visited: Vec<u32> = Vec::new();
        let mut seen: HashSet<u32> = HashSet::new();
        let mut queue: VecDeque<u32> = roots.iter().copied().collect();
        while let Some(pid) = queue.pop_front() {
            if visited.len() >= MAX_TREE {
                break;
            }
            if pid == 0 || !seen.insert(pid) {
                continue;
            }
            visited.push(pid);
            let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) else { continue };
            for task in tasks.flatten() {
                let children = std::fs::read_to_string(task.path().join("children")).unwrap_or_default();
                queue.extend(children.split_whitespace().filter_map(|child| child.parse::<u32>().ok()));
            }
        }
        visited
    }

    #[cfg(unix)]
    fn owner(path: &Path) -> Option<u32> {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path).ok().map(|info| info.uid())
    }
    #[cfg(not(unix))]
    fn owner(_path: &Path) -> Option<u32> {
        None
    }

    /// This user's processes whose `/proc/<pid>/cwd` is in `directory`.
    pub fn in_directory(directory: &Path) -> Vec<u32> {
        let own = std::process::id();
        let user = owner(Path::new("/proc/self"));
        let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
        let mut found: Vec<u32> = entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
            .filter(|pid| *pid != own)
            .filter(|pid| {
                let process = format!("/proc/{pid}");
                // A process of another user cannot be read, and is none of this application's.
                user.is_none_or(|user| owner(Path::new(&process)) == Some(user))
                    && std::fs::read_link(format!("{process}/cwd")).is_ok_and(|cwd| cwd.starts_with(directory))
            })
            .collect();
        found.sort_unstable();
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_cpu_times_in_either_systems_format() {
        assert_eq!(cpu_time("0:00.03"), 3);
        assert_eq!(cpu_time("1:23.45"), 8_345);
        assert_eq!(cpu_time("00:01:23"), 8_300);
        assert_eq!(cpu_time("2-03:04:05"), (2 * 86_400 + 3 * 3_600 + 4 * 60 + 5) * 100);
        assert_eq!(cpu_time("75:00.5"), 450_050);
        assert_eq!(cpu_time("junk"), 0);
    }

    #[test]
    fn parses_the_process_table_of_ps_on_macos_and_linux() {
        let macos = "    1     0 Ss     2:11.90 /sbin/launchd\n  501     1 S      0:00.03 /bin/zsh -l\n 7001   501 R+     1:02.50 python train.py --epochs 10\nnot a line\n";
        let table = parse_ps(macos);
        assert_eq!(table.len(), 3);
        assert_eq!(table[2], ProcessSnapshot { pid: 7001, ppid: 501, state: "R+".into(), cpu_ticks: 6_250, cmd: "python train.py --epochs 10".into() });
        let linux = "      1       0 S 00:00:07 /sbin/init splash\n   4242    4000 R 00:10:00 make -j8\n";
        assert_eq!(parse_ps(linux)[1], ProcessSnapshot { pid: 4242, ppid: 4000, state: "R".into(), cpu_ticks: 60_000, cmd: "make -j8".into() });
        let long = format!("5 1 S 0:00.00 {}", "x".repeat(400));
        assert_eq!(parse_ps(&long)[0].cmd.len(), 180);
    }

    #[test]
    fn follows_a_tree_through_the_table_without_looping() {
        let process = |pid, ppid| ProcessSnapshot { pid, ppid, state: "S".into(), cpu_ticks: 0, cmd: format!("p{pid}") };
        // 10 → 11 → 12, 10 → 13; 20 is unrelated; 30 and 31 name each other as parents.
        let table = vec![process(10, 1), process(11, 10), process(12, 11), process(13, 10), process(20, 1), process(30, 31), process(31, 30)];
        let pids = |roots: &[u32]| table_tree(roots, &table).into_iter().map(|process| process.pid).collect::<Vec<_>>();
        assert_eq!(pids(&[10]), vec![10, 11, 13, 12]);
        assert_eq!(pids(&[11, 20, 11]), vec![11, 20, 12]);
        assert_eq!(pids(&[30]), vec![30, 31]);
        assert!(pids(&[99]).is_empty() && pids(&[]).is_empty());
    }

    #[test]
    fn finds_working_directories_in_lsof_output() {
        let own = std::process::id();
        let output = format!("p101\nfcwd\nn/Users/me/work/t1\np102\nfcwd\nn/Users/me/work/t1/build\np103\nfcwd\nn/Users/me/work/t10\np104\nfcwd\nn/\np{own}\nfcwd\nn/Users/me/work/t1\n");
        assert_eq!(parse_lsof(&output, Path::new("/Users/me/work/t1")), vec![101, 102]);
        assert!(parse_lsof("", Path::new("/x")).is_empty());
    }

    #[test]
    fn parses_the_windows_process_table() {
        let output =
            "0\t0\t0\tSystem Idle Process\t\r\n4\t0\t1250000\tSystem\t\r\n8120\t4400\t31250000\tpython.exe\t\"C:\\Python\\python.exe\" train.py\r\nbad\r\n";
        let table = parse_windows(output);
        assert_eq!(table.len(), 3);
        assert_eq!(table[1], ProcessSnapshot { pid: 4, ppid: 0, state: "?".into(), cpu_ticks: 12, cmd: "System".into() });
        assert_eq!((table[2].ppid, table[2].cpu_ticks, table[2].cmd.as_str()), (4400, 312, "\"C:\\Python\\python.exe\" train.py"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn samples_live_processes_by_tree_and_by_working_directory() {
        let directory = std::env::temp_dir().join(format!("neo-procinfo-{}", std::process::id()));
        std::fs::create_dir_all(directory.join("sub")).unwrap();
        let directory = directory.canonicalize().unwrap();
        let mut shell = Command::new("sh").args(["-c", "sleep 30 & cd sub && sleep 31 & wait"]).current_dir(&directory).spawn().unwrap();
        let found = (0..100)
            .find_map(|_| {
                std::thread::sleep(std::time::Duration::from_millis(20));
                let found = in_directory(&directory);
                (found.len() >= 3).then_some(found)
            })
            .expect("the shell and both sleeps are found by their working directory");
        assert!(found.contains(&shell.id()));
        let processes = tree(&[shell.id()]);
        let commands: Vec<&str> = processes.iter().map(|process| process.cmd.as_str()).collect();
        assert!(commands.contains(&"sleep 30") && commands.contains(&"sleep 31"), "{commands:?}");
        assert_eq!(processes[0].pid, shell.id());
        assert!(processes.iter().skip(1).all(|process| process.ppid != 0 && !process.state.is_empty()));
        // The same tree through `ps`, as other systems read it.
        let listed = table_tree(&[shell.id()], &table());
        if !listed.is_empty() {
            assert!(listed.iter().any(|process| process.cmd == "sleep 30"), "{listed:?}");
        }
        for process in processes.iter().skip(1) {
            let _ = Command::new("kill").arg(process.pid.to_string()).status();
        }
        let _ = shell.kill();
        let _ = shell.wait();
        assert!(!in_directory(&directory).contains(&shell.id()));
        assert!(in_directory(Path::new("/nonexistent-directory")).is_empty());
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
