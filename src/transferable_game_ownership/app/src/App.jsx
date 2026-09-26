import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LAMPORTS_PER_SOL,
  buyLicense,
  buyListedLicense,
  cancelListing,
  connection,
  explorerAddress,
  explorerTx,
  fetchBorrowed,
  fetchLibrary,
  fetchListings,
  fetchStore,
  getProgram,
  isOnLoan,
  lendLicense,
  listForSale,
  splitPrice,
} from "./chain";
import "./App.css";

const LOAN_OPTIONS = [
  { label: "1 minute (demo)", minutes: 1 },
  { label: "10 minutes", minutes: 10 },
  { label: "1 hour", minutes: 60 },
  { label: "1 day", minutes: 1440 },
];

function getPhantom() {
  const provider = window.phantom?.solana ?? window.solana;
  return provider?.isPhantom ? provider : null;
}

function short(address) {
  const s = address.toString();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function sol(lamports) {
  return (lamports / LAMPORTS_PER_SOL).toFixed(3);
}

function formatRemaining(secondsLeft) {
  if (secondsLeft <= 0) return "expired";
  const totalMinutes = Math.floor(secondsLeft / 60);
  const seconds = Math.floor(secondsLeft % 60);
  if (totalMinutes >= 60) {
    return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m left`;
  }
  return totalMinutes > 0 ? `${totalMinutes}m ${seconds}s left` : `${seconds}s left`;
}

function clockTime(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function App() {
  const [phantom, setPhantom] = useState(null);
  const [publicKey, setPublicKey] = useState(null);
  const [balance, setBalance] = useState(null);
  const [store, setStore] = useState([]);
  const [library, setLibrary] = useState([]);
  const [borrowed, setBorrowed] = useState([]);
  const [listings, setListings] = useState([]);
  const [loadingStore, setLoadingStore] = useState(true);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [busyGameId, setBusyGameId] = useState(null);
  const [busyAction, setBusyAction] = useState(null);
  const [status, setStatus] = useState(null);
  // { license: base58, mode: "lend" | "sell" }
  const [form, setForm] = useState(null);
  const [lendAddress, setLendAddress] = useState("");
  const [lendMinutes, setLendMinutes] = useState(10);
  const [askPrice, setAskPrice] = useState("0.2");
  // Loans expire by wall clock, so the UI re-evaluates every second instead of needing a refresh.
  const [now, setNow] = useState(() => Date.now() / 1000);

  const program = useMemo(() => getProgram(publicKey ? phantom : null), [phantom, publicKey]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const provider = getPhantom();
    setPhantom(provider);
    if (!provider) return;

    provider.on("connect", (key) => setPublicKey(key));
    provider.on("disconnect", () => setPublicKey(null));
    provider.on("accountChanged", (key) => setPublicKey(key ?? null));

    // Reconnect silently if this site was already approved. Reads the resolved value rather than
    // relying only on the "connect" event, which not every wallet build emits.
    provider
      .connect({ onlyIfTrusted: true })
      .then((res) => setPublicKey(res?.publicKey ?? provider.publicKey ?? null))
      .catch(() => {});
  }, []);

  const refreshMarket = useCallback(async () => {
    setLoadingStore(true);
    try {
      const [games, open] = await Promise.all([fetchStore(program), fetchListings(program)]);
      setStore(games);
      setListings(open);
    } finally {
      setLoadingStore(false);
    }
  }, [program]);

  const refreshWallet = useCallback(async () => {
    if (!publicKey) {
      setLibrary([]);
      setBorrowed([]);
      setBalance(null);
      return;
    }
    setLoadingLibrary(true);
    try {
      const [owned, lent, lamports] = await Promise.all([
        fetchLibrary(program, publicKey),
        fetchBorrowed(program, publicKey),
        connection.getBalance(publicKey),
      ]);
      setLibrary(owned);
      setBorrowed(lent);
      setBalance(lamports / LAMPORTS_PER_SOL);
    } finally {
      setLoadingLibrary(false);
    }
  }, [program, publicKey]);

  useEffect(() => {
    refreshMarket();
  }, [refreshMarket]);

  useEffect(() => {
    refreshWallet();
  }, [refreshWallet]);

  const connectWallet = useCallback(async () => {
    try {
      const res = await phantom.connect();
      setPublicKey(res?.publicKey ?? phantom.publicKey ?? null);
    } catch {
      // user dismissed the wallet prompt
    }
  }, [phantom]);

  /** Runs a chain action, then re-reads state from the chain rather than assuming it worked. */
  async function run(key, message, action) {
    setBusyAction(key);
    setStatus(null);
    try {
      const signature = await action();
      setStatus({ kind: "success", message, signature });
      setForm(null);
      await Promise.all([refreshMarket(), refreshWallet()]);
    } catch (err) {
      setStatus({ kind: "error", message: err.message ?? String(err) });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleBuy(game) {
    setBusyGameId(game.id);
    setStatus(null);
    try {
      const signature = await buyLicense(program, game);
      setStatus({ kind: "success", message: `Bought ${game.title}`, signature });
      await Promise.all([refreshMarket(), refreshWallet()]);
    } catch (err) {
      setStatus({ kind: "error", message: err.message ?? String(err) });
    } finally {
      setBusyGameId(null);
    }
  }

  const listingByLicense = useMemo(
    () => new Map(listings.map((l) => [l.licenseAddress.toBase58(), l])),
    [listings]
  );
  const othersListings = publicKey
    ? listings.filter((l) => !l.seller.equals(publicKey))
    : listings;

  const askLamports = Math.round((Number(askPrice) || 0) * LAMPORTS_PER_SOL);
  const askSplit = splitPrice(askLamports);
  const askValid = askPrice.trim() !== "" && Number.isFinite(Number(askPrice)) && Number(askPrice) >= 0;

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">◈</span>
          <div>
            <h1>Transferable Game Ownership</h1>
            <p className="tagline">Licenses you actually own — lendable, resellable.</p>
          </div>
        </div>

        <div className="wallet">
          <span className="net-pill">devnet</span>
          {publicKey ? (
            <>
              <div className="wallet-info">
                <a href={explorerAddress(publicKey)} target="_blank" rel="noreferrer">
                  {short(publicKey)}
                </a>
                {balance !== null && <span className="balance">{balance.toFixed(3)} SOL</span>}
              </div>
              <button className="ghost" onClick={() => phantom.disconnect()}>
                Disconnect
              </button>
            </>
          ) : phantom ? (
            <button className="primary" onClick={connectWallet}>
              Connect Wallet
            </button>
          ) : (
            <a className="primary" href="https://phantom.app/" target="_blank" rel="noreferrer">
              Install Phantom
            </a>
          )}
        </div>
      </header>

      {status && (
        <div className={`status ${status.kind}`}>
          <span>{status.message}</span>
          {status.signature && (
            <a href={explorerTx(status.signature)} target="_blank" rel="noreferrer">
              View transaction ↗
            </a>
          )}
          <button className="close" onClick={() => setStatus(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {borrowed.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Borrowed from friends</h2>
            <span className="count">{borrowed.length}</span>
          </div>
          <div className="grid">
            {borrowed.map((license) => {
              const active = isOnLoan(license, now);
              return (
                <article
                  className={`card ${active ? "borrowed" : ""}`}
                  key={license.address.toBase58()}
                >
                  <div className="art" style={{ background: license.accent }}>
                    <span>{license.title.charAt(0)}</span>
                  </div>
                  <div className="body">
                    <h3>{license.title}</h3>
                    <p className="meta">
                      Copy #{license.licenseId} · owned by {short(license.owner)}
                    </p>
                    <div className="row">
                      {active ? (
                        <span className="pill info">
                          Borrowed — playable · {formatRemaining(license.expiry - now)}
                        </span>
                      ) : (
                        <span className="pill muted">Loan ended — back with the owner</span>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <section>
        <div className="section-head">
          <h2>My Library</h2>
          <span className="count">
            {publicKey ? `${library.length} license${library.length === 1 ? "" : "s"}` : ""}
          </span>
        </div>

        {!publicKey ? (
          <p className="empty">Connect your wallet to see the licenses it owns.</p>
        ) : loadingLibrary ? (
          <p className="empty">Reading licenses from the chain…</p>
        ) : library.length === 0 ? (
          <p className="empty">No licenses yet — buy one from the store below.</p>
        ) : (
          <div className="grid">
            {library.map((license) => {
              const key = license.address.toBase58();
              const onLoan = isOnLoan(license, now);
              const listing = listingByLicense.get(key);
              const openForm = form?.license === key ? form.mode : null;
              const busy = busyAction === key;

              return (
                <article
                  className={`card ${onLoan ? "lent" : listing ? "listed" : "owned"}`}
                  key={key}
                >
                  <div className="art" style={{ background: license.accent }}>
                    <span>{license.title.charAt(0)}</span>
                  </div>
                  <div className="body">
                    <h3>{license.title}</h3>
                    <p className="meta">
                      Copy #{license.licenseId} · bought{" "}
                      {new Date(license.purchasedAt * 1000).toLocaleDateString()}
                    </p>

                    <div className="row">
                      {onLoan ? (
                        <span className="pill warn">Lent out until {clockTime(license.expiry)}</span>
                      ) : listing ? (
                        <span className="pill sale">For sale · {sol(listing.priceLamports)} SOL</span>
                      ) : (
                        <span className="pill ok">Owned — playable</span>
                      )}
                      <a
                        className="link"
                        href={explorerAddress(license.address)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        on-chain ↗
                      </a>
                    </div>

                    {onLoan ? (
                      <p className="meta">
                        {short(license.borrower)} is playing it ·{" "}
                        {formatRemaining(license.expiry - now)}
                      </p>
                    ) : listing ? (
                      <>
                        <p className="meta">
                          You receive {sol(listing.toSeller)} SOL · developer royalty{" "}
                          {sol(listing.royalty)} SOL
                        </p>
                        <button
                          className="ghost wide"
                          disabled={busy}
                          onClick={() =>
                            run(key, `Withdrew ${license.title} from sale`, () =>
                              cancelListing(program, license.address)
                            )
                          }
                        >
                          {busy ? "Confirming…" : "Withdraw from sale"}
                        </button>
                      </>
                    ) : openForm === "lend" ? (
                      <div className="sub-form">
                        <input
                          value={lendAddress}
                          onChange={(e) => setLendAddress(e.target.value)}
                          placeholder="Friend's wallet address"
                          spellCheck="false"
                        />
                        <select
                          value={lendMinutes}
                          onChange={(e) => setLendMinutes(Number(e.target.value))}
                        >
                          {LOAN_OPTIONS.map((o) => (
                            <option key={o.minutes} value={o.minutes}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        <div className="row">
                          <button className="ghost" onClick={() => setForm(null)}>
                            Cancel
                          </button>
                          <button
                            className="primary"
                            disabled={busy || lendAddress.trim().length < 32}
                            onClick={() =>
                              run(
                                key,
                                `Lent ${license.title} copy #${license.licenseId} for ${lendMinutes} minutes`,
                                () => lendLicense(program, license, lendAddress.trim(), lendMinutes)
                              )
                            }
                          >
                            {busy ? "Confirming…" : "Confirm loan"}
                          </button>
                        </div>
                      </div>
                    ) : openForm === "sell" ? (
                      <div className="sub-form">
                        <label className="field">
                          <span>Asking price (SOL)</span>
                          <input
                            value={askPrice}
                            onChange={(e) => setAskPrice(e.target.value)}
                            inputMode="decimal"
                            spellCheck="false"
                          />
                        </label>
                        <p className="split">
                          You get <strong>{sol(askSplit.toSeller)}</strong> SOL · developer royalty{" "}
                          <strong>{sol(askSplit.royalty)}</strong> SOL (10%)
                        </p>
                        <div className="row">
                          <button className="ghost" onClick={() => setForm(null)}>
                            Cancel
                          </button>
                          <button
                            className="primary"
                            disabled={busy || !askValid}
                            onClick={() =>
                              run(
                                key,
                                `Listed ${license.title} copy #${license.licenseId} for ${askPrice} SOL`,
                                () => listForSale(program, license, Number(askPrice))
                              )
                            }
                          >
                            {busy ? "Confirming…" : "List for sale"}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="row">
                        <button
                          className="ghost"
                          onClick={() => setForm({ license: key, mode: "lend" })}
                        >
                          Lend
                        </button>
                        <button
                          className="ghost"
                          onClick={() => setForm({ license: key, mode: "sell" })}
                        >
                          Sell
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="section-head">
          <h2>Used copies for sale</h2>
          <span className="count">
            {loadingStore ? "loading…" : `${othersListings.length} listed`}
          </span>
        </div>

        {othersListings.length === 0 ? (
          <p className="empty">
            Nobody is reselling a copy right now. List one of yours and it appears here for everyone
            else.
          </p>
        ) : (
          <div className="grid">
            {othersListings.map((listing) => {
              const key = listing.listingAddress.toBase58();
              const busy = busyAction === key;
              return (
                <article className="card resale" key={key}>
                  <div className="art" style={{ background: listing.accent }}>
                    <span>{listing.title.charAt(0)}</span>
                  </div>
                  <div className="body">
                    <h3>{listing.title}</h3>
                    <p className="meta">
                      Used · copy #{listing.licenseId} · from {short(listing.seller)}
                    </p>
                    <p className="split">
                      Seller gets <strong>{sol(listing.toSeller)}</strong> SOL · developer royalty{" "}
                      <strong>{sol(listing.royalty)}</strong> SOL
                    </p>
                    <div className="row">
                      <span className="price">{sol(listing.priceLamports)} SOL</span>
                      <button
                        className="primary"
                        disabled={!publicKey || busy}
                        onClick={() =>
                          run(key, `Bought ${listing.title} copy #${listing.licenseId}`, () =>
                            buyListedLicense(program, listing)
                          )
                        }
                      >
                        {busy ? "Confirming…" : "Buy used"}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="section-head">
          <h2>Store — new copies</h2>
          <span className="count">{loadingStore ? "loading…" : `${store.length} games`}</span>
        </div>

        <div className="grid">
          {store.map((game) => (
            <article className="card" key={game.id}>
              <div className="art" style={{ background: game.accent }}>
                <span>{game.title.charAt(0)}</span>
              </div>
              <div className="body">
                <h3>{game.title}</h3>
                <p className="blurb">{game.blurb}</p>
                {game.listed ? (
                  <>
                    <p className="meta">
                      {game.soldCount} sold · dev {short(game.developer)}
                    </p>
                    <div className="row">
                      <span className="price">{sol(game.priceLamports)} SOL</span>
                      <button
                        className="primary"
                        disabled={!publicKey || busyGameId !== null}
                        onClick={() => handleBuy(game)}
                      >
                        {busyGameId === game.id ? "Confirming…" : "Buy"}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="meta">Not listed on-chain yet — run scripts/seed_games.mjs</p>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>

      <footer className="foot">
        <p>
          One copy, one player: while a licence is lent out the owner cannot play it, and access
          returns automatically when the loan expires — no transaction needed. Resales settle
          atomically and pay the developer 10% every time a copy changes hands, however many times
          it is resold. All of it read straight from the Solana devnet ledger, not from this store's
          server.
        </p>
      </footer>
    </div>
  );
}
