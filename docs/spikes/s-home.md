# S-HOME: reaching a world on a home PC (spike S0.10)

**Question.** Can players reach a world hosted on a home PC in Colombia, where many connections sit behind carrier-grade NAT, within 5 seconds and without anything that costs money?

**Status.** The census tool is built and checked (2026-10-17). The census itself is run by the owner and the testers on their own networks; the connectivity matrix needs the relays (Cloudflare's free TURN and coturn on an Oracle Always Free VM), and kyonax.com's DNS moves to Cloudflare first. Those are the owner's accounts and go-aheads, so this report fills in as they happen.

## The pass lines (the MVP plan's S0.10)

| Line | Status |
|---|---|
| Results from at least 5 networks on at least 3 Colombian ISPs, with the CGNAT rate per ISP written to the brain | the census, below |
| Every tester connects within 5 s by some path (direct or mapped, hole punching, or a relay) | after the relays |
| The relay adds at most 40 ms of round trip | after the relays |
| kyonax.com's website and mail work as before the DNS move | after the move (the owner's go-ahead) |
| Nothing costs money | the free tiers only |

## The census (for the owner and the testers)

One command, no window, about 5 seconds. It prints one line and can save it to a file to send back:

```sh
# Windows, from the unzipped client (the latest CI run's client-windows zip):
FlatChat.exe --census --census-out=census.json
# Linux:
./flatchat --census --census-out=census.json
```

Turn off any VPN first (Cloudflare WARP included): the census would describe the VPN, not the home network. On the owner's desktop with WARP on it reported exactly that, an endpoint-dependent mapping and no port mapping, so relay-only.

**What it asks, and what it never does.** Every probe only asks; none changes the router. Two public STUN servers (Cloudflare's and Google's) are asked from one local socket what address and port they see, which shows how the NAT maps a player. One more STUN query goes over IPv6. The router is asked whether it speaks UPnP, NAT-PMP or PCP, and for its external address. The reverse DNS of the public address names the ISP. What a router answers is read through fixed patterns and never run.

**What it keeps.** Derived facts only, never the tester's address:

| Field | Meaning |
|---|---|
| `mapping` | `none` (the machine holds a public address), `endpoint-independent` (hole punching works), `endpoint-dependent` (it usually does not), `unknown`, `blocked` |
| `cgnat` | true when the router's own external address is private or shared (100.64.0.0/10), or differs from the public one; null when the router does not say |
| `portMapping` | which of UPnP, NAT-PMP and PCP the router answers |
| `ipv6` | a global IPv6 address, and whether it reached the STUN server over IPv6 |
| `canHost` | one line for a host: `direct`, `with-port-mapping`, `hole-punching` or `relay-only` |
| `isp` | the ISP's name from the reverse DNS, when there is one |
| `gpu` | the graphics card's vendor and device IDs, to find the real Iris Xe and 680M laptops that tune the stand-in (OQ-6) |

The agents record each result in the brain by ISP (the CGNAT rate per ISP is the pass line's number) and never keep an address.

## Next

1. The owner runs the census at home (WARP off) and sends the census command to the testers.
2. The relays: a Cloudflare account's free TURN (Calls) and coturn on an Oracle Always Free VM, both the owner's accounts.
3. kyonax.com's DNS moves to Cloudflare with every record exported and recreated, the website and mail checked before and after (the owner's go-ahead, OQ-8); then the core's HTTPS goes out through a Cloudflare Tunnel on a subdomain.
4. The connectivity matrix: each tester joins a world on the owner's PC direct or mapped, by hole punching, and forced through each relay; the time to connect and the relay's added round trip are recorded.
