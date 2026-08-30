//! `pi --list-models` and model checking: refuse a `--model` pattern pi
//! cannot resolve before a worktree exists, naming the closest models it
//! does have. A worker spawned with a bad model dies a minute later, after a
//! worktree and a branch exist, with the reason buried in its state file —
//! the names are cheap to ask for, so a spawn checks first.
//! (Ported from the TypeScript `src/models.ts`.)

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use crate::paths::env_var;

/// How long the listing may take before the check gives up and allows the spawn.
const LIST_TIMEOUT: Duration = Duration::from_secs(10);

/// The listing is asked for at most once per pi binary and process; only a
/// non-empty answer is worth remembering (an empty one means pi could not be
/// asked). Keyed by the spec so tests pointing at different fakes never share
/// an answer.
static CACHE: LazyLock<Mutex<HashMap<String, Vec<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// `PARL_PI_BIN` is an executable spec split on spaces
/// ("node /path/fake-pi.mjs"); the default is plain `pi`.
#[must_use]
pub fn pi_bin_spec() -> String {
    std::env::var(env_var("PI_BIN")).unwrap_or_else(|_| "pi".into())
}

/// Model names pi reports, or an empty list when it cannot be asked.
pub async fn list_models(pi_bin: &str) -> Vec<String> {
    if let Some(cached) = CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(pi_bin)
        .cloned()
    {
        return cached;
    }
    let mut argv = pi_bin.split_whitespace();
    let Some(bin) = argv.next() else {
        return Vec::new();
    };
    let mut command = tokio::process::Command::new(bin);
    command.args(argv).arg("--list-models");
    let output = match tokio::time::timeout(LIST_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        // Spawn failure, or the child outlived its welcome (dropping the
        // future kills it): either way pi is unaskable.
        Ok(Err(_)) | Err(_) => return Vec::new(),
    };
    // "provider  model  context  max-out  thinking  images" — the name is the
    // second whitespace column, under a header line.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut names: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for line in stdout.lines().skip(1) {
        if let Some(name) = line.split_whitespace().nth(1)
            && seen.insert(name.to_string())
        {
            names.push(name.to_string());
        }
    }
    if !names.is_empty() {
        CACHE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(pi_bin.to_string(), names.clone());
    }
    names
}

/// `None` when the model is fine or pi cannot be asked; otherwise a message
/// naming the closest models, so the caller can pick one straight away.
pub async fn check_model(pi_bin: &str, pattern: Option<&str>) -> anyhow::Result<Option<String>> {
    let Some(pattern) = pattern.filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    let models = list_models(pi_bin).await;
    // An empty listing means pi could not be asked, which is not the user's problem.
    if models.is_empty() || models.iter().any(|m| m == pattern) {
        return Ok(None);
    }
    let near = closest(pattern, &models);
    let suffix = if near.is_empty() {
        String::new()
    } else {
        format!("; did you mean {}?", near.join(", "))
    };
    Ok(Some(format!(
        "unknown model \"{pattern}\"{suffix} (pi --list-models shows all {})",
        models.len()
    )))
}

/// Models whose name contains, or is contained by, what was asked for.
fn closest(model: &str, models: &[String]) -> Vec<String> {
    let wanted = model.to_lowercase();
    let mut scored: Vec<String> = models
        .iter()
        .filter(|m| {
            let name = m.to_lowercase();
            name.contains(&wanted) || wanted.contains(&name) || shares_stem(&name, &wanted)
        })
        .cloned()
        .collect();
    scored.sort_by_key(|m| m.len().abs_diff(model.len()));
    scored.truncate(3);
    scored
}

/// "glm-5.3-max" and "glm-5.3" share a stem; "glm-5.3-max" and "gpt-6" do not.
fn shares_stem(a: &str, b: &str) -> bool {
    let stem = |s: &str| -> String { s.split(['-', '/']).take(2).collect::<Vec<_>>().join("-") };
    stem(a) == stem(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::{RETRY_BOUND, RETRY_INTERVAL};
    use crate::util::new_id;
    use std::path::PathBuf;
    use std::time::Instant;

    fn write_fake_pi(body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "parl-models-{}-{}",
            std::process::id(),
            new_id("t").replace('_', "")
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-pi.sh");
        std::fs::write(&script, body).unwrap();
        script
    }

    fn listing_script(rows: &[&str]) -> String {
        let body: String = rows.iter().map(|r| format!("  echo '{r}'\n")).collect();
        write_fake_pi(&format!(
            "#!/bin/sh\ncase \" $* \" in *--list-models*)\n  echo 'provider           model                context'\n{body};;\nesac\n"
        ))
        .to_string_lossy()
        .into_owned()
    }

    /// The `sh <script>` listing can transiently come back empty under
    /// full-suite parallel load (the spawn fails a moment after the script is
    /// written). The production code correctly refuses to cache an empty
    /// listing — an empty answer means pi could not be asked, never a
    /// definitive none — so the test polls until a real one arrives; a
    /// listing that never fills still fails the test, via the bound.
    async fn listed_models(pi: &str) -> Vec<String> {
        let deadline = Instant::now() + RETRY_BOUND;
        loop {
            let models = list_models(pi).await;
            if !models.is_empty() {
                return models;
            }
            assert!(
                Instant::now() < deadline,
                "pi listing for {pi} never returned models"
            );
            tokio::time::sleep(RETRY_INTERVAL).await;
        }
    }

    #[tokio::test]
    async fn parses_the_second_column_and_dedupes() {
        let pi = listing_script(&[
            "  fake               glm-5.3                1M",
            "  fake               glm-5.3                1M",
            "  fake               glm-5.3-flash                1M",
        ]);
        let pi = format!("sh {pi}");
        let models = listed_models(&pi).await;
        assert_eq!(models, vec!["glm-5.3", "glm-5.3-flash"]);
        // The listing is cached per pi spec: a second ask does not run pi again.
        let again = list_models(&pi).await;
        assert_eq!(again, models);
    }

    #[tokio::test]
    async fn known_model_passes_and_unknown_names_the_closest() {
        let pi = format!(
            "sh {}",
            listing_script(&[
                "  fake               glm-5.3                1M",
                "  fake               glm-5.3-flash                1M",
                "  fake               claude-sonnet-5                1M",
            ])
        );
        // prime the cache through the bounded poll; the checks below then
        // read the one real listing, however many transient spawns it took
        listed_models(&pi).await;
        assert_eq!(check_model(&pi, None).await.unwrap(), None);
        assert_eq!(check_model(&pi, Some("glm-5.3")).await.unwrap(), None);
        let bad = check_model(&pi, Some("glm-5.3-max"))
            .await
            .unwrap()
            .unwrap();
        assert!(bad.contains("unknown model \"glm-5.3-max\""), "{bad}");
        assert!(bad.contains("did you mean glm-5.3-flash, glm-5.3"), "{bad}");
        assert!(bad.contains("shows all 3"), "{bad}");
        // Nothing similar at all: still refused, no suggestions.
        let alien = check_model(&pi, Some("zort-9000")).await.unwrap().unwrap();
        assert!(alien.contains("unknown model \"zort-9000\""), "{alien}");
        assert!(!alien.contains("did you mean"), "{alien}");
    }

    #[tokio::test]
    async fn an_unaskable_pi_never_blocks_a_spawn() {
        assert_eq!(
            list_models("definitely-not-a-real-pi-bin").await,
            Vec::<String>::new()
        );
        assert_eq!(
            check_model("definitely-not-a-real-pi-bin", Some("anything-at-all"))
                .await
                .unwrap(),
            None
        );
    }

    #[test]
    fn stem_heuristic_matches_version_variants_only() {
        assert!(shares_stem("glm-5.3", "glm-5.3-max"));
        assert!(shares_stem("glm/5.3", "glm-5.3-max"));
        assert!(!shares_stem("glm-5.3-max", "gpt-6"));
    }
}
