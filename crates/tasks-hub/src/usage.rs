//! How much the interface is used: a count per day, on this machine only.
//!
//! The question of the P2 review is whether the read-only interface is
//! opened every day. This is the answer, kept as the least that answers it:
//! per day (UTC) the number of visits and the minutes an event stream was
//! open. Nothing of a task, an area or a person goes in, and nothing leaves
//! the machine: it is a file next to `config.json`, `usage.json`, and the
//! command `tasks-hub usage` that reads it.
//!
//! A visit begins with a stream that opens when there was no sign of use
//! for ten minutes (a reload or a second tab is the same visit). A tab that
//! stays open for days is a visit each time its window gets the focus back
//! after such a pause: the page asks for a rescan then, and that is the sign.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// A pause longer than this makes the next stream a new visit.
const VISIT_GAP: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Day {
    pub visits: u32,
    pub seconds: u64,
}

#[derive(Serialize, Deserialize)]
struct File {
    schema: u32,
    days: BTreeMap<String, Day>,
}

struct State {
    days: BTreeMap<String, Day>,
    open: usize,
    segment_start: Option<Instant>,
    /// The last sign of use: a stream opened or ended, a window in focus.
    last_activity: Option<Instant>,
}

/// The most days kept; older ones are dropped.
const KEEP_DAYS: usize = 400;

pub struct UsageLog {
    path: Option<PathBuf>,
    state: Mutex<State>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian
/// (Howard Hinnant's algorithm).
#[must_use]
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = u32::try_from(doy - (153 * mp + 2) / 5 + 1).unwrap_or(1);
    let m = u32::try_from(if mp < 10 { mp + 3 } else { mp - 9 }).unwrap_or(1);
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The inverse of [`civil_from_days`].
#[must_use]
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = i64::from(if m > 2 { m - 3 } else { m + 9 });
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn day_key(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Today in UTC, as `YYYY-MM-DD`.
#[must_use]
pub fn today() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    day_key(i64::try_from(secs / 86_400).unwrap_or(0))
}

impl UsageLog {
    /// Keep the log in `path`, or in memory only with `None`. A file that is
    /// missing or cannot be read is an empty log.
    #[must_use]
    pub fn open(path: Option<PathBuf>) -> Self {
        let days = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str::<File>(&t).ok())
            .filter(|f| f.schema == 1)
            .map(|f| f.days)
            .unwrap_or_default();
        Self {
            path,
            state: Mutex::new(State {
                days,
                open: 0,
                segment_start: None,
                last_activity: None,
            }),
        }
    }

    /// An event stream was opened.
    pub fn stream_opened(&self) {
        self.opened_at(Instant::now(), today());
    }

    /// An event stream ended.
    pub fn stream_closed(&self) {
        self.closed_at(Instant::now(), today());
    }

    /// The window of the interface got the focus: somebody is there. A tab
    /// that was left open counts as a new visit after a pause.
    pub fn touched(&self) {
        self.touched_at(Instant::now(), today());
    }

    fn touched_at(&self, now: Instant, day: String) {
        let mut state = lock(&self.state);
        let pause = state
            .last_activity
            .is_none_or(|t| now.saturating_duration_since(t) >= VISIT_GAP);
        state.last_activity = Some(now);
        if pause && state.open > 0 {
            state.days.entry(day).or_default().visits += 1;
            self.persist(&state);
        }
    }

    fn opened_at(&self, now: Instant, day: String) {
        let mut state = lock(&self.state);
        if state.open == 0 {
            let new_visit = state
                .last_activity
                .is_none_or(|t| now.saturating_duration_since(t) >= VISIT_GAP);
            if new_visit {
                state.days.entry(day).or_default().visits += 1;
            }
            state.segment_start = Some(now);
        }
        state.last_activity = Some(now);
        state.open += 1;
        self.persist(&state);
    }

    fn closed_at(&self, now: Instant, day: String) {
        let mut state = lock(&self.state);
        state.open = state.open.saturating_sub(1);
        if state.open == 0 {
            if let Some(start) = state.segment_start.take() {
                let seconds = now.saturating_duration_since(start).as_secs();
                state.days.entry(day).or_default().seconds += seconds;
            }
            state.last_activity = Some(now);
            self.persist(&state);
        }
    }

    fn persist(&self, state: &State) {
        let Some(path) = &self.path else { return };
        let mut days = state.days.clone();
        while days.len() > KEEP_DAYS {
            days.pop_first();
        }
        let file = File { schema: 1, days };
        let Ok(text) = serde_json::to_string_pretty(&file) else {
            return;
        };
        let tmp = path.with_extension("json.tmp");
        // A log that cannot be written is not a reason to stop the hub.
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

/// The last `count` days up to and including `today`, newest last, and what
/// they hold; and the line that answers the question.
#[must_use]
pub fn report(days: &BTreeMap<String, Day>, today: &str, count: u32) -> String {
    let parts: Vec<&str> = today.split('-').collect();
    let (Some(y), Some(m), Some(d)) = (
        parts.first().and_then(|s| s.parse::<i64>().ok()),
        parts.get(1).and_then(|s| s.parse::<u32>().ok()),
        parts.get(2).and_then(|s| s.parse::<u32>().ok()),
    ) else {
        return String::new();
    };
    let end = days_from_civil(y, m, d);
    let mut out = String::new();
    let mut used = 0u32;
    let mut visits = 0u32;
    let mut seconds = 0u64;
    for back in (0..i64::from(count)).rev() {
        let key = day_key(end - back);
        let day = days.get(&key).cloned().unwrap_or_default();
        if day.visits > 0 || day.seconds > 0 {
            used += 1;
        }
        visits += day.visits;
        seconds += day.seconds;
        let bar = "#".repeat(usize::try_from(day.visits.min(20)).unwrap_or(0));
        out.push_str(&format!(
            "{key}  {:>2} visit(s)  {:>4} min  {bar}\n",
            day.visits,
            day.seconds / 60
        ));
    }
    out.push_str(&format!(
        "\nopened on {used} of the last {count} days, {visits} visit(s), {} min open (days are UTC)\n",
        seconds / 60
    ));
    out
}

/// Read a usage file as the command shows it.
#[must_use]
pub fn read_days(path: &std::path::Path) -> BTreeMap<String, Day> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<File>(&t).ok())
        .filter(|f| f.schema == 1)
        .map(|f| f.days)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_round_trip_through_days() {
        for (y, m, d) in [(1970, 1, 1), (2026, 10, 12), (2024, 2, 29), (2000, 12, 31)] {
            assert_eq!(civil_from_days(days_from_civil(y, m, d)), (y, m, d));
        }
        assert_eq!(day_key(0), "1970-01-01");
        assert_eq!(day_key(days_from_civil(2026, 10, 12)), "2026-10-12");
    }

    #[test]
    fn a_reload_and_a_second_tab_are_one_visit() {
        let log = UsageLog::open(None);
        let t0 = Instant::now();
        log.opened_at(t0, "2026-10-12".into());
        // A second tab while the first is open, a reload a minute later.
        log.opened_at(t0 + Duration::from_secs(5), "2026-10-12".into());
        log.closed_at(t0 + Duration::from_secs(60), "2026-10-12".into());
        log.closed_at(t0 + Duration::from_secs(120), "2026-10-12".into());
        log.opened_at(t0 + Duration::from_secs(180), "2026-10-12".into());
        log.closed_at(t0 + Duration::from_secs(240), "2026-10-12".into());
        let days = lock(&log.state).days.clone();
        let day = days.get("2026-10-12").unwrap();
        assert_eq!(day.visits, 1);
        assert_eq!(day.seconds, 120 + 60);
    }

    #[test]
    fn a_tab_left_open_is_a_visit_when_it_is_looked_at_again() {
        let log = UsageLog::open(None);
        let t0 = Instant::now();
        log.opened_at(t0, "2026-10-12".into());
        // The window is focused again a minute later: nothing new.
        log.touched_at(t0 + Duration::from_secs(60), "2026-10-12".into());
        // The next morning, the same tab, the stream still open.
        let day = Duration::from_secs(20 * 3600);
        log.touched_at(t0 + day, "2026-10-13".into());
        // Focused again two minutes later: the same visit.
        log.touched_at(t0 + day + Duration::from_secs(120), "2026-10-13".into());
        let days = lock(&log.state).days.clone();
        assert_eq!(days.get("2026-10-12").unwrap().visits, 1);
        assert_eq!(days.get("2026-10-13").unwrap().visits, 1);
    }

    #[test]
    fn a_focus_without_a_stream_is_not_a_visit() {
        let log = UsageLog::open(None);
        log.touched_at(Instant::now(), "2026-10-12".into());
        assert!(lock(&log.state).days.is_empty());
    }

    #[test]
    fn only_the_last_days_are_kept() {
        let dir =
            std::env::temp_dir().join(format!("tasks-desktop-usage-keep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("usage.json");
        let log = UsageLog::open(Some(path.clone()));
        {
            let mut state = lock(&log.state);
            for i in 0..(KEEP_DAYS + 30) {
                let key = day_key(i64::try_from(i).unwrap() + 19_000);
                state.days.insert(
                    key,
                    Day {
                        visits: 1,
                        seconds: 0,
                    },
                );
            }
        }
        let t0 = Instant::now();
        log.opened_at(t0, day_key(19_000 + 500));
        assert_eq!(read_days(&path).len(), KEEP_DAYS);
        // The oldest were dropped from the file, the newest are there.
        assert!(!read_days(&path).contains_key(&day_key(19_000)));
        assert!(read_days(&path).contains_key(&day_key(19_000 + 429)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_long_pause_is_a_new_visit() {
        let log = UsageLog::open(None);
        let t0 = Instant::now();
        log.opened_at(t0, "2026-10-12".into());
        log.closed_at(t0 + Duration::from_secs(30), "2026-10-12".into());
        log.opened_at(t0 + Duration::from_secs(30 + 11 * 60), "2026-10-12".into());
        log.closed_at(t0 + Duration::from_secs(40 + 11 * 60), "2026-10-12".into());
        let days = lock(&log.state).days.clone();
        assert_eq!(days.get("2026-10-12").unwrap().visits, 2);
    }

    #[test]
    fn the_log_survives_a_restart_and_holds_nothing_else() {
        let dir = std::env::temp_dir().join(format!("tasks-desktop-usage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("usage.json");
        let log = UsageLog::open(Some(path.clone()));
        let t0 = Instant::now();
        log.opened_at(t0, "2026-10-12".into());
        log.closed_at(t0 + Duration::from_secs(90), "2026-10-12".into());
        let again = UsageLog::open(Some(path.clone()));
        assert_eq!(lock(&again.state).days.get("2026-10-12").unwrap().visits, 1);
        let text = std::fs::read_to_string(&path).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(doc["schema"], 1);
        // Counts and dates: no other key anywhere.
        let day = &doc["days"]["2026-10-12"];
        assert_eq!(day.as_object().unwrap().len(), 2);
        assert_eq!(doc.as_object().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_or_foreign_file_is_an_empty_log() {
        let dir =
            std::env::temp_dir().join(format!("tasks-desktop-usage-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("usage.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(read_days(&path).is_empty());
        std::fs::write(
            &path,
            r#"{"schema":2,"days":{"2026-10-12":{"visits":9,"seconds":1}}}"#,
        )
        .unwrap();
        assert!(read_days(&path).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_report_answers_the_question() {
        let mut days = BTreeMap::new();
        days.insert(
            "2026-10-12".to_owned(),
            Day {
                visits: 2,
                seconds: 600,
            },
        );
        days.insert(
            "2026-10-10".to_owned(),
            Day {
                visits: 1,
                seconds: 59,
            },
        );
        days.insert(
            "2026-09-01".to_owned(),
            Day {
                visits: 5,
                seconds: 5,
            },
        );
        let text = report(&days, "2026-10-12", 7);
        assert!(text.contains("opened on 2 of the last 7 days"), "{text}");
        assert!(text.contains("3 visit(s)"), "{text}");
        assert!(text.contains("2026-10-06"), "{text}");
        // A day outside the window is not counted.
        assert!(!text.contains("2026-09-01"), "{text}");
    }
}
