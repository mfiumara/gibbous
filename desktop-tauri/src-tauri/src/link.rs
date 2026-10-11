//! Pure helpers: where the Gibbous server is and how to sign in to it. Mirrors desktop/Gibbous.swift.
use url::Url;

/// A saved route must look like one the server's /login?next= accepts, or launch would land on home anyway.
/// Same rule as server/main.ts and web/src/macshell.ts `isRoute`.
pub fn is_route(h: &str) -> bool {
    let Some(rest) = h.strip_prefix("#/") else { return false };
    rest.chars().all(|c| c.is_ascii_alphanumeric() || "_/?=&%.~-".contains(c))
}

/// scheme://host[:port] of an http(s) url.
pub fn origin(u: &Url) -> Option<Url> {
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none() {
        return None;
    }
    let mut o = u.clone();
    o.set_path("/");
    o.set_query(None);
    o.set_fragment(None);
    let _ = o.set_username("");
    let _ = o.set_password(None);
    Some(o)
}

pub fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

fn token_of(u: &Url) -> Option<String> {
    u.query_pairs().find(|(k, _)| k == "token").map(|(_, v)| v.into_owned()).filter(|t| !t.is_empty())
}

/// What the user pasted on the connect screen: a sign-in link (server + token), a bare server url, or a bare token
/// (for the server already configured).
#[derive(Debug, PartialEq)]
pub struct Pasted {
    pub server: Option<Url>,
    pub token: Option<String>,
}
pub fn parse_pasted(raw: &str) -> Option<Pasted> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.contains("://") {
        let u = Url::parse(raw).ok()?;
        return Some(Pasted { server: Some(origin(&u)?), token: token_of(&u) });
    }
    // host:port without a scheme
    if raw.contains(':') || raw.contains('.') {
        if let Ok(u) = Url::parse(&format!("http://{raw}")) {
            if u.host_str().is_some() && !raw.contains(char::is_whitespace) && (u.port().is_some() || raw.contains('.')) {
                return Some(Pasted { server: origin(&u), token: token_of(&u) });
            }
        }
    }
    if raw.chars().all(|c| c.is_ascii_alphanumeric() || "-_.~+/=".contains(c)) {
        return Some(Pasted { server: None, token: Some(raw.to_string()) });
    }
    None
}

fn enc(v: &str) -> String {
    let mut s = String::new();
    for b in v.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            s.push(b as char)
        } else {
            s.push_str(&format!("%{b:02X}"))
        }
    }
    s
}

/// The url that signs in (sets the cookie) and lands on `next`. Without a token, the app itself: a saved cookie
/// signs in, otherwise the page shows its own Sign in screen.
pub fn login_url(base: &Url, token: &str, next: &str) -> Url {
    let root = base.as_str().trim_end_matches('/');
    let next = if is_route(next) { next } else { "" };
    let s = if token.is_empty() {
        format!("{root}/{next}")
    } else {
        // Encoded by hand: & and = inside a route like #/search?q=a&b must not split the query.
        format!("{root}/login?token={}&next={}", enc(token), enc(next))
    };
    Url::parse(&s).unwrap_or_else(|_| base.clone())
}

/// The server's own sign-in link (GIBBOUS_HOME/login-url).
pub fn parse_login_file(s: &str) -> Option<Url> {
    Url::parse(s.trim()).ok().filter(|u| matches!(u.scheme(), "http" | "https"))
}

/// secret.json {accessToken}, else the token inside login-url.
pub fn local_token(secret_json: Option<&str>, link: Option<&Url>) -> String {
    secret_json
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v.get("accessToken")?.as_str().map(str::to_string))
        .filter(|t| !t.is_empty())
        .or_else(|| link.and_then(token_of))
        .unwrap_or_default()
}

/// Links the page hands to the OS: web pages, mail, and the editors' url schemes. Never file:, javascript: or
/// anything else that would run a program.
pub fn openable(u: &Url) -> bool {
    matches!(
        u.scheme(),
        "http" | "https" | "mailto" | "tel" | "vscode" | "vscode-insiders" | "cursor" | "zed" | "windsurf" | "jetbrains" | "idea" | "subl"
    )
}

/// A file name the page suggested, made safe to create in Downloads.
pub fn safe_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() { "download".into() } else { cleaned }
}

/// `dir/name`, or `name 2.ext`, `name 3.ext`… when taken (never overwrites).
pub fn unique_path(dir: &std::path::Path, name: &str, exists: impl Fn(&std::path::Path) -> bool) -> std::path::PathBuf {
    let p = dir.join(name);
    if !exists(&p) {
        return p;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..).map(|n| dir.join(format!("{stem} {n}{ext}"))).find(|p| !exists(p)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes() {
        assert!(is_route("#/t/abc-123"));
        assert!(is_route("#/search?q=a%20b&x=1"));
        assert!(is_route("#/"));
        assert!(!is_route("#/t/<x>"));
        assert!(!is_route("/t/x"));
        assert!(!is_route(""));
    }

    #[test]
    fn login_urls() {
        let b = Url::parse("http://127.0.0.1:7878").unwrap();
        assert_eq!(login_url(&b, "a+b/c", "#/t/x").as_str(), "http://127.0.0.1:7878/login?token=a%2Bb%2Fc&next=%23%2Ft%2Fx");
        assert_eq!(login_url(&b, "tok", "#/search?q=a&b=1").as_str(), "http://127.0.0.1:7878/login?token=tok&next=%23%2Fsearch%3Fq%3Da%26b%3D1");
        assert_eq!(login_url(&b, "", "#/t/x").as_str(), "http://127.0.0.1:7878/#/t/x");
        assert_eq!(login_url(&b, "tok", "javascript:x").as_str(), "http://127.0.0.1:7878/login?token=tok&next=");
    }

    #[test]
    fn pasted_links() {
        let p = parse_pasted(" https://mac.tail1.ts.net:8444/login?token=abc ").unwrap();
        assert_eq!(p.server.unwrap().as_str(), "https://mac.tail1.ts.net:8444/");
        assert_eq!(p.token.as_deref(), Some("abc"));
        let p = parse_pasted("192.168.1.5:7878").unwrap();
        assert_eq!(p.server.unwrap().as_str(), "http://192.168.1.5:7878/");
        assert_eq!(p.token, None);
        assert_eq!(parse_pasted("Zx_9-abc").unwrap(), Pasted { server: None, token: Some("Zx_9-abc".into()) });
        assert_eq!(parse_pasted("   "), None);
        assert_eq!(parse_pasted("file:///etc/passwd"), None);
    }

    #[test]
    fn tokens() {
        let link = Url::parse("http://127.0.0.1:7878/login?token=fromlink").unwrap();
        assert_eq!(local_token(Some(r#"{"accessToken":"sec"}"#), Some(&link)), "sec");
        assert_eq!(local_token(Some("{}"), Some(&link)), "fromlink");
        assert_eq!(local_token(None, None), "");
    }

    #[test]
    fn origins() {
        let a = Url::parse("http://127.0.0.1:7878/#/t/x").unwrap();
        assert!(same_origin(&a, &Url::parse("http://127.0.0.1:7878/api/media?path=x").unwrap()));
        assert!(!same_origin(&a, &Url::parse("http://127.0.0.1:7879/").unwrap()));
        assert!(!same_origin(&a, &Url::parse("https://example.com/").unwrap()));
        assert_eq!(origin(&Url::parse("https://u:p@h.example:9/x?y#z").unwrap()).unwrap().as_str(), "https://h.example:9/");
    }

    #[test]
    fn opening() {
        assert!(openable(&Url::parse("https://example.com").unwrap()));
        assert!(openable(&Url::parse("vscode://file/home/me/x.ts").unwrap()));
        assert!(!openable(&Url::parse("file:///bin/sh").unwrap()));
        assert!(!openable(&Url::parse("javascript:alert(1)").unwrap()));
    }

    #[test]
    fn filenames() {
        assert_eq!(safe_filename("../../etc/passwd"), "passwd");
        assert_eq!(safe_filename("C:\\x\\a:b.png"), "a_b.png");
        assert_eq!(safe_filename(".."), "download");
        let taken = ["/d/a.png", "/d/a 2.png"];
        let p = unique_path(std::path::Path::new("/d"), "a.png", |p| taken.contains(&p.to_str().unwrap()));
        assert_eq!(p, std::path::PathBuf::from("/d/a 3.png"));
        let p = unique_path(std::path::Path::new("/d"), "README", |_| false);
        assert_eq!(p, std::path::PathBuf::from("/d/README"));
    }
}
