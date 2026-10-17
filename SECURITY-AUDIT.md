# Server security audit — 2026-10-17

## Deployment follow-up — 2026-10-17

The isolation changes below are now deployed at https://voicesite.remoth.net.
The original findings remain below as the audit record, not a description of the
current service unit.

- Rootless Podman runs under the separate `hosting` account. The old `tmn` service
  is disabled. The container mounts only Voicesite data and read-only models;
  app code is in the read-only image. Its effective capabilities are zero,
  no-new-privileges is enabled, and seccomp filtering is active. Chrome's own
  sandbox works with a narrow `chroot` syscall allowance for its nested namespace.
- Resource budgets were subsequently removed at the owner's request: no explicit
  CPU, memory, process, temporary-storage, log, or data-volume quota. Worker thread
  counts use library defaults unless configured. Data lives under
  `/home/hosting/projects/voicesite/data`; the original 16 GiB volume remains a
  rollback copy. Resource exhaustion remains possible and can affect the host.
- Redeployment copies all tracked/unignored project source and the complete `.env`.
  The environment file is stored privately and mounted read-only outside the image;
  container-specific paths and ports take precedence.
- Root-owned nftables rules restrict hosting-account egress. Verified public HTTPS
  succeeds while direct account connections to active host IPv4/IPv6 loopback
  listeners fail. From the production container, a controlled host listener, host
  gateway, and link-local metadata address are unreachable. Its user manager
  requires the firewall service and data mount at boot.
- Full browser/speech/effects/OCR/captioning checks passed under hosting. The
  migrated database passed SQLite quick_check; all 20 snapshot documents matched
  the original content hash, and all 434 speech files were present. The public
  homepage and saved Example Domain page loaded successfully after cutover.
- The first cutover rolled back automatically when Cloudflare rejected the health
  check's default Python user agent. An explicit deployment user agent fixed the
  check, and the second cutover completed. Original data and the failed-cutover
  copy are retained for recovery.

Application-level anonymous abuse controls and per-user browser-state ownership
remain outstanding. Containers share the host kernel; the new boundaries reduce
host exposure, rather than guarantee immunity from container/kernel exploits.

Scope: protecting the hosting computer from anonymous users of the public site. Reviewed server routes, URL fetching and DNS validation, browser fallback/proxy, subprocesses, image/speech processing, persistence, authentication, and the installed systemd service. Original-page replay/XSS was lower priority, except where it affects server operations.

**Assessment:** no direct command injection, arbitrary filesystem access, SQL injection, or private-address fetch bypass was identified in this review. However, this deployment is not adequately isolated from the owner's computer. Anonymous resource exhaustion is possible without exploiting a dependency; a successful exploit in a server process would have the owner's user permissions. This is a bounded code/configuration review, not proof that exploitable vulnerabilities are absent.

## 1. High priority: public hostile-content processing runs as the desktop user

Evidence: `deploy/voicesite.service:6`, `server/browser-capture.js:59`, `server/image-reading.js:18`, `server/speech.js:14`, `server/effects.js:29`.

The installed service matches the repository unit and runs as `tmn`. Live systemd properties show `ProtectHome=no`, `ProtectSystem=no`, `PrivateTmp=no`, `NoNewPrivileges=no`, `MemoryMax=infinity`, and `CPUQuotaPerSecUSec=infinity`. TasksMax is 37419, rather than an application-specific small limit. No separate app OS/container boundary is configured by this unit.

An attacker can host an HTTP 403 response and submit its URL to the anonymous capture endpoint, causing Chrome fallback to visit attacker-controlled content. Chrome's sandbox is explicitly enabled, and this is **not itself demonstrated remote code execution**. But a browser sandbox escape, a vulnerability in Node/native libraries, or a native image-decoder exploit would land in a service running with the owner's permissions. The Python image worker processes arbitrary caller-selected raster images outside Chrome's sandbox. Chrome explicitly inherits the app environment, which includes the loaded admin password; Python children inherit the environment by default. Ordinary source JavaScript cannot simply read these secrets, but compromise of the containing process would expose them.

Remediation: run the complete service and its workers in a dedicated VM or a restricted container/service account, without the owner's home directory, SSH keys, desktop session sockets, container-management sockets, or unrelated credentials. Mount app/model files read-only and grant write access only to dedicated app data. Enforce CPU, memory, process, and disk limits. Give workers a minimal environment. Preserve Chrome's own sandbox. For the strongest separation from a personal computer, use a separate host or VM with restricted networking.

Temporary reduction in attack surface: set `BROWSER_CAPTURE=0` or restrict creation/processing endpoints to authenticated users until worker isolation is implemented. Disabling browser fallback alone does not isolate the HTML/image processing paths.

## 2. High priority: anonymous callers can grow disk and memory and sustain expensive jobs

Evidence: `server/index.js:24`, `server/index.js:32`, `server/index.js:54`, `server/renditions.js:77`, `server/renditions.js:115`, `server/store.js:32`.

Capture, image analysis, speech, rendition registration/generation, and effect processing are public. Origin/Fetch Metadata checks mitigate browser cross-origin requests; scripts outside a browser can omit these headers and pass the checks. They are not authentication or abuse protection.

Rendition registration accepts caller-supplied words for any existing snapshot, without proving those words belong to the snapshot. Each distinct valid registration writes a manifest and retains a job in an unbounded Map. A request may contain up to 8 MB of JSON and 100,000 words. Generation saves audio clips permanently; full-generation jobs can survive client disconnects and restart. Capture snapshots and image-reading caches also have no total storage quotas or eviction. Existing concurrency/queue limits are helpful, but do not bound cumulative storage or sustained work. Expensive HTML parsing occurs in the API process, so request timeouts do not provide a hard CPU/memory limit for parsing.

Safe reproduction: started a separate loopback app instance with a mock existing snapshot, temporary storage, and inference disabled. Two POST requests to `/api/snapshots/audit-snapshot/speech-renditions`, with different arbitrary text and no cookies or Origin header, both returned 200 and wrote two persistent manifests. Anonymous admin listing returned 401. Temporary files were removed. No production writes or exhaustion tests were performed.

Remediation: enforce aggregate storage quotas/free-space floors, bounded job caches and job admission, global concurrency/work budgets, and per-client/user rate limits. Put these controls before expensive body parsing where possible. Cap aggregate rendition text/chunks and outstanding full-generation jobs. Use a bounded storage volume so filling the archive cannot fill the host filesystem. Authentication for creation/processing is the simplest immediate restriction; if these features must remain anonymous, quotas and isolation are essential. Keep public reading separate from expensive creation permissions.

## 3. Medium priority: private-network protection depends on application/browser behavior

Evidence: `server/fetch.js:12`, `server/fetch.js:38`, `server/browser-proxy.js:9`, `server/browser-capture.js:59`.

Positive findings: HTTP(S) only, standard ports only, no URL credentials, all DNS answers checked, public IP connections pinned, redirects revalidated, decoded response size limits, and connection cleanup. Browser traffic uses a validating proxy; implicit loopback bypass, QUIC, direct DNS resolution, and non-proxied WebRTC UDP are disabled. No bypass was found in the reviewed code/tests.

The service unit nevertheless does not enforce a network boundary. A future browser/proxy mistake or compromised worker could reach loopback/LAN services as the host user. Public-address filtering also does not prohibit reaching sensitive services on publicly routable addresses. This is a defense-in-depth gap, not a demonstrated SSRF exploit.

Remediation: enforce private/LAN/link-local/metadata/host-network restrictions at the worker network boundary, including IPv6 and the host's own public addresses where applicable. Confine the browser to its validating proxy at the OS/network layer. Allow only the DNS/proxy access required for the design. OWASP recommends network-layer controls alongside application SSRF validation: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

## 4. Medium priority, conditional: browser login state is shared between callers

Evidence: `server/browser-capture.js:66`, `server/browser-capture.js:115`, `server/index.js:49`.

Browser cookies/local storage are persisted by source origin, not by user. If the owner signs into a personal account through the verification browser, later anonymous captures for that origin can reuse the session and save authenticated content into the shared archive. Exact-source-URL version lookup is public, even though the global listing requires admin access. Dedicated browser state avoids reading the personal Chrome profile, but does not isolate sessions between people using this service.

Remediation: keep the capture browser anonymous, discard persistent state where feasible, or introduce per-user state and private snapshot authorization before supporting authenticated source sites. Do not sign into personal accounts through verification. No authenticated-content leak was attempted or observed during this audit.

## Other observations

- Admin sign-in failures are counted by the direct connection address. Behind the tunnel, callers can share that address; ten failed attempts can lock out legitimate admin login for 15 minutes. This is an availability issue, not an authentication bypass. If changing this, trust client-IP headers only from the verified proxy path.
- Voicesite listens on `127.0.0.1:28767`, consistent with a tunnel origin. Other services listen on wildcard interfaces, including ports 22, 3000, 3773, 3389, and 3390. That does not prove Internet reachability; router, IPv6, firewall, and other tunnel routes were not audited. These services should be included in a separate host exposure inventory.
- Original-page replay has an opaque-origin sandbox and reader HTML is sanitized. Showing the source URL helps users judge what they visit, but it does not protect the server: server-side capture runs before any visitor chooses to execute source content in their own browser.

## Validation and limits

- `pnpm test`: 60 passed, zero failed/skipped. Includes DNS pinning/private-address rejection, redirects, proxy behavior, admin verification protection, and subprocess input validation.
- `pnpm audit --prod --json`: zero reported JavaScript dependency vulnerabilities. This does not establish that all runtime/native components are patched or safe.
- Observed Node v24.20.0 and Google Chrome 155.0.8059.39. Python image environment includes Pillow 12.3.0, torch 2.6.0+cpu, transformers 4.57.3, onnxruntime 1.23.2, rapidocr 3.4.1. A comprehensive Python/native/OS vulnerability scan and browser sandbox runtime verification were not completed.
- Inspected live service properties and listening sockets. Did not change/restart the deployment, probe private services, perform destructive load tests, or inspect secret values in output.
- Existing uncommitted frontend changes were preserved. Only this audit document was added.

Suggested order: isolate the whole app from the personal host; add hard resource/storage budgets and creation admission controls; enforce worker egress restrictions; then address state ownership and secondary availability issues. Authentication can be applied first as a short-term exposure reduction while isolation is built.
