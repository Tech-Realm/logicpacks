# LogicPacks Connect troubleshooting

A LogicPacks Connect connection goes through four parts, in this order:

1. **This device** reaches LogicPacks Connect over the internet.
2. **LogicPacks Connect** checks your sign-in and the host's link.
3. **The host's tunnel** (cloudflared on the host) carries the request to the host.
4. **LogicPacks on the host** answers.

When a connection fails, open **Settings > Environments**, find the environment,
and select **Details**. The first part marked as failed is the cause. Find its
section below.

To see the host's side, run `logicpacks connect status` on the host, or open
**Settings > Sharing & access** on the host. Both check the host's LogicPacks Connect
address from the host, and say why it fails. `logicpacks connect` runs the same check
when it finishes setup. This check cannot test another device's network. For a
problem on one device, use **Details** on that device.

## The host's tunnel is offline

LogicPacks Connect could not reach the host's tunnel. This means one of these:

- The host is asleep, turned off, or offline.
- LogicPacks is not running on the host.
- The host's network blocks the tunnel. See
  [Port 7844 is blocked on the host](#port-7844-is-blocked-on-the-host).

Fix:

1. Make sure the host is awake and LogicPacks runs on it.
2. On the host, run `logicpacks connect status`. It names the problem on the host's side.
3. If the host was offline for a long time, LogicPacks Connect removes its tunnel. Start
   LogicPacks on the host and update it to the latest version. It gets a new tunnel.

## Port 7844 is blocked on the host

The tunnel on the host connects out to Cloudflare on port 7844, with TCP and
UDP. Both tunnel protocols (QUIC and HTTP/2) use this port. When the host's
network blocks it, the tunnel cannot start, but normal web traffic still works.
The host looks online, so this problem is easy to miss.

Common causes:

- **A Tailscale exit node on the host.** All of the host's internet traffic goes
  through the exit node, and that network blocks port 7844. Turn off the exit
  node on the host with `tailscale set --exit-node=`, or allow outbound port
  7844 on the exit node's network.
- **A VPN on the host.** Work VPNs often block unknown ports. Ask for port 7844
  to be allowed, or use a direct route instead (see below).
- **A firewall or strict network.** Allow outbound TCP and UDP port 7844.

If you cannot unblock the port, you can connect without LogicPacks Connect. When the
host and this device are on the same Tailscale network, add the host's
Tailscale address as a direct route. See
[Reach one machine several ways](./remote-access.md#reach-one-machine-several-ways).

## The tunnel works, but LogicPacks does not answer

The host's tunnel is up, but it cannot reach LogicPacks on the host. Common causes:

- LogicPacks on the host stopped, crashed, or is still starting.
- LogicPacks restarted on a different port, for example after an update, and the
  tunnel still points at the old port.
- The server binds only one network address with `LOGICPACKS_HOST`. The tunnel
  sends requests to `127.0.0.1`, so the server must also listen there.

Fix: restart LogicPacks on the host. For the background service, run
`logicpacks service restart`. Then run `logicpacks connect status` on the host.

## The LogicPacks Connect address does not resolve or answer

The host's LogicPacks Connect address did not resolve, refused the connection, failed a
secure (TLS) connection, or did not answer in time.

Fix:

1. Make sure the host is awake and online.
2. On the host, run `logicpacks connect status`.
3. If the check fails only on the host, check the host's DNS, VPN, or proxy.

## This device can't reach LogicPacks Connect

The problem is on this device's network, not on the host. This device could
not reach LogicPacks Connect, or it reached LogicPacks Connect but not the host's tunnel
address.

Fix:

1. Check this device's internet connection. On a captive or dead Wi-Fi network,
   the device can look online but cannot reach anything.
2. A VPN, firewall, ad blocker, or DNS filter on this device can block LogicPacks
   Connect. Turn it off for a moment to test.
3. On iPhone, Connectivity Assist in the Wi-Fi settings can break LogicPacks Connect.
   Turn it off to test.
4. Try another network, or add a direct route to the host, such as its
   Tailscale address. See
   [Reach one machine several ways](./remote-access.md#reach-one-machine-several-ways).

## Sign-in, account, or link problems

LogicPacks Connect does not have an active link between your account and the host.

- **The host is linked to a different account.** Sign in to the same LogicPacks Connect
  account on this device and on the host. On the host, run `logicpacks connect logout`,
  then `logicpacks connect`.
- **LogicPacks Connect is off on the host, or the host only publishes agent activity.**
  On the host, open **Settings > Sharing & access** and turn **LogicPacks Connect** on, or
  run `logicpacks connect`.
- **The host was linked, but the server did not apply the link yet.** Run
  `logicpacks service restart` on the host, or restart `logicpacks serve`.
- **This device's sign-in expired, or the host no longer accepts this
  device.** Sign out of LogicPacks Connect and sign in again.
- **Your account reached its tunnel limit.** Remove an environment you do not
  use from your LogicPacks account's LogicPacks Connect page, or
  [link a paid LogicPacks Chat account](./remote-access.md#more-machines-with-lp-chat)
  for a higher limit. Then restart LogicPacks on the host.

## The clock is off

LogicPacks Connect signs requests with short-lived proofs. When the clock on this
device or the host is a few minutes wrong, LogicPacks Connect rejects them. Turn on
automatic date and time on both devices, then retry.

## The host runs an older LogicPacks

This app needs a newer LogicPacks on the host. Update LogicPacks on the host. See
[Updating LogicPacks](./updating.md).

## LogicPacks Connect returned an error

| Error                                                     | Fix                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Remove an unused environment or link a paid LogicPacks Chat account, then restart LogicPacks on the host.                                                           |
| `auth_invalid` or `invalid_bearer`                        | Run `logicpacks connect login`. If credentials were revoked, run `logicpacks connect logout`, then `logicpacks connect` again. Restart the server after signing in. |
| Expired or invalid link proof                             | Check the host's date and time, update LogicPacks, then restart it.                                                                                                 |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                                                       |
| HTTP 408, 429, or 5xx                                     | Wait a few minutes. LogicPacks retries temporary failures on its own.                                                                                               |

After you fix a permanent rejection, restart the host's server with
`logicpacks service restart`. For a foreground server, stop it and run `logicpacks serve` again.

If LogicPacks on the host disappears when SSH closes, see
[background-service troubleshooting](./background-service.md#troubleshooting).

## Report a problem

If none of this helps, open an issue on
[GitHub](https://github.com/Tech-Realm/logicpacks/issues). Include:

- The text from **Copy diagnostics** in the environment's **Details**.
- The output of `logicpacks connect status` on the host.
- The trace ID, if one is shown.
