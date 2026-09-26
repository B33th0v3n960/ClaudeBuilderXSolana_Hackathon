import { useCallback, useEffect, useMemo, useState } from "react";
import games from "./games.json";
import {
  CLUSTER,
  PROGRAM_ID,
  RPC_URL,
  fetchEntitlements,
  gamePda,
  getProgram,
  verdictFor,
} from "./verify";
import "./App.css";

const BADGE = {
  owned: { label: "LICENCE VERIFIED", mark: "✓", tone: "ok" },
  borrowed: { label: "LICENCE VERIFIED — BORROWED", mark: "✓", tone: "ok" },
  "lent-out": { label: "LENT OUT", mark: "🔒", tone: "warn" },
  "loan-expired": { label: "LOAN EXPIRED", mark: "✕", tone: "bad" },
  "no-licence": { label: "NO LICENCE", mark: "✕", tone: "bad" },
};

function short(s) {
  return s ? `${s.slice(0, 4)}…${s.slice(-4)}` : "—";
}

function countdown(secondsLeft) {
  if (secondsLeft <= 0) return "expired";
  const m = Math.floor(secondsLeft / 60);
  const s = Math.floor(secondsLeft % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function explorer(address) {
  return `https://explorer.solana.com/address/${address}?cluster=${CLUSTER}`;
}

export default function App() {
  const [input, setInput] = useState("");
  const [wallet, setWallet] = useState(null);
  const [entitlements, setEntitlements] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(null);
  const [showEvidence, setShowEvidence] = useState(null);
  const [now, setNow] = useState(() => Date.now() / 1000);

  // Verdicts re-derive from the clock with no extra RPC, so a loan lapsing flips the screen live.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);

  const gameAccounts = useMemo(() => {
    const programId = getProgram().programId;
    return games.map((g) => ({ ...g, account: gamePda(programId, g.id).toBase58() }));
  }, []);

  const check = useCallback(async (address) => {
    setChecking(true);
    setError(null);
    setRunning(null);
    try {
      const result = await fetchEntitlements(address.trim());
      setEntitlements(result);
      setWallet(result.wallet);
    } catch (err) {
      setEntitlements(null);
      setError(err.message ?? String(err));
    } finally {
      setChecking(false);
    }
  }, []);

  async function connectPhantom() {
    const provider = window.phantom?.solana ?? window.solana;
    if (!provider?.isPhantom) {
      setError("Phantom not found. Paste a wallet address instead.");
      return;
    }
    try {
      const res = await provider.connect();
      const address = (res?.publicKey ?? provider.publicKey).toBase58();
      setInput(address);
      await check(address);
    } catch {
      // dismissed
    }
  }

  return (
    <div className="shell">
      <header>
        <div className="title">
          <span className="chip">LAUNCHER</span>
          <h1>Licence Verifier</h1>
        </div>
        <p className="independence">
          This launcher is a <strong>separate application</strong>. It shares no code, no server and
          no database with the store — it reads the ledger directly. Stop the store and reload this
          page: it still works.
        </p>
        <dl className="wiring">
          <div>
            <dt>Program</dt>
            <dd>
              <a href={explorer(PROGRAM_ID)} target="_blank" rel="noreferrer">
                {PROGRAM_ID}
              </a>
            </dd>
          </div>
          <div>
            <dt>RPC</dt>
            <dd>{RPC_URL}</dd>
          </div>
          <div>
            <dt>Store API</dt>
            <dd className="none">none — not used</dd>
          </div>
        </dl>
      </header>

      <section className="lookup">
        <label htmlFor="wallet">Wallet to verify</label>
        <div className="lookup-row">
          <input
            id="wallet"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste any wallet address…"
            spellCheck="false"
            onKeyDown={(e) => e.key === "Enter" && input.trim() && check(input)}
          />
          <button
            className="primary"
            disabled={checking || input.trim().length < 32}
            onClick={() => check(input)}
          >
            {checking ? "Reading chain…" : "Verify"}
          </button>
          <button className="ghost" onClick={connectPhantom}>
            Use my wallet
          </button>
        </div>
        <p className="hint">
          Any address works — no signature, no permission, nothing to sign. Verification is a read.
        </p>
        {error && <p className="error">{error}</p>}
      </section>

      {entitlements && (
        <>
          <p className="summary">
            Verified <code>{short(wallet)}</code> against the chain ·{" "}
            {entitlements.owned.length} licence{entitlements.owned.length === 1 ? "" : "s"} owned ·{" "}
            {entitlements.borrowed.length} loan record{entitlements.borrowed.length === 1 ? "" : "s"}{" "}
            · 2 RPC calls
            <button className="relink" onClick={() => check(wallet)}>
              re-check
            </button>
          </p>

          <div className="games">
            {gameAccounts.map((game) => {
              const v = verdictFor(entitlements, game.account, now);
              const badge = BADGE[v.basis];
              const isRunning = running === game.id && v.playable;
              const evidenceOpen = showEvidence === game.id;

              return (
                <article className={`game ${badge.tone}`} key={game.id}>
                  <div className="stripe" style={{ background: game.accent }} />
                  <div className="game-body">
                    <div className="game-head">
                      <h2>{game.title}</h2>
                      <span className={`verdict ${badge.tone}`}>
                        <span className="mark">{badge.mark}</span> {badge.label}
                      </span>
                    </div>

                    <p className="reason">{v.reason}</p>

                    {v.until != null && v.until > now && (
                      <p className="timer">
                        {v.basis === "borrowed" ? "Playable for" : "Returns to you in"}{" "}
                        <strong>{countdown(v.until - now)}</strong>
                      </p>
                    )}

                    <div className="actions">
                      <button
                        className={v.playable ? "primary" : "primary"}
                        disabled={!v.playable}
                        onClick={() => setRunning(game.id)}
                      >
                        {isRunning ? "▶ Running" : v.playable ? "▶ Launch game" : "Launch blocked"}
                      </button>
                      <button
                        className="ghost small"
                        onClick={() => setShowEvidence(evidenceOpen ? null : game.id)}
                      >
                        {evidenceOpen ? "Hide evidence" : "Show evidence"}
                      </button>
                    </div>

                    {isRunning && (
                      <div className="running">
                        <span className="dot" /> {game.title} is running. The launcher re-checks the
                        chain, so if this licence is lent out the session ends.
                      </div>
                    )}

                    {evidenceOpen && (
                      <div className="evidence">
                        <div className="rule">
                          <span>Rule applied</span>
                          <code>
                            borrower set AND expiry &gt; now → borrower plays; else owner plays
                          </code>
                        </div>
                        <table>
                          <tbody>
                            <tr>
                              <th>Game account</th>
                              <td>
                                <a href={explorer(game.account)} target="_blank" rel="noreferrer">
                                  {game.account}
                                </a>
                              </td>
                            </tr>
                            <tr>
                              <th>Checked at</th>
                              <td>
                                {new Date(v.evidence.checkedAt * 1000).toLocaleTimeString()} (unix{" "}
                                {v.evidence.checkedAt})
                              </td>
                            </tr>
                            {[...v.evidence.ownedCopies, ...v.evidence.borrowedCopies].length ===
                            0 ? (
                              <tr>
                                <th>Licence accounts</th>
                                <td className="none">
                                  none found for this wallet and this game
                                </td>
                              </tr>
                            ) : (
                              [...v.evidence.ownedCopies, ...v.evidence.borrowedCopies].map((c) => (
                                <tr key={c.address}>
                                  <th>Copy #{c.copyId}</th>
                                  <td>
                                    <a
                                      href={explorer(c.address)}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      {c.address}
                                    </a>
                                    <br />
                                    owner <code>{c.owner}</code>
                                    <br />
                                    borrower <code>{c.borrower ?? "none"}</code>
                                    <br />
                                    expiry <code>{c.expiry}</code>
                                    {c.expiry > 0 && (
                                      <> ({new Date(c.expiry * 1000).toLocaleString()})</>
                                    )}
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}

      <footer>
        <p>
          <strong>What this does and doesn't prove.</strong> It proves entitlement can be checked by
          anyone, with no cooperation from the store — that's the portability claim. It is not
          anti-piracy: a patched game binary can always skip this check, exactly as with ordinary
          DRM. Titles and cover art come from this launcher's own local list; the ledger records only
          game IDs.
        </p>
      </footer>
    </div>
  );
}
