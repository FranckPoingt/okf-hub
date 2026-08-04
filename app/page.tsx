"use client";

import { useState } from "react";

const steps = [
  ["01", "Connect sources", "Bring three repositories into one trusted view."],
  ["02", "Write a policy", "Publish company knowledge without Git or YAML."],
  ["03", "Find the answer", "Search imported and hub-native knowledge together."],
] as const;

export default function Home() {
  const [step, setStep] = useState(0);

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="OKF Hub home">
          <span className="brand-mark">O</span>
          OKF Hub
        </a>
        <span className="prototype-label">Design partner preview · KH-01</span>
      </header>

      <section className="intro" id="top">
        <div>
          <p className="eyebrow">One company. Many sources. One trusted view.</p>
          <h1>Knowledge that stays<br />close to the work.</h1>
        </div>
        <p className="intro-copy">
          Follow Maya, an operations lead, as she connects technical knowledge,
          publishes a company policy, and finds both without learning Git.
        </p>
      </section>

      <section className="demo" aria-label="Clickable workflow narrative">
        <nav className="steps" aria-label="Workflow steps">
          {steps.map(([number, title, description], index) => (
            <button
              className={step === index ? "step active" : "step"}
              key={number}
              onClick={() => setStep(index)}
              aria-current={step === index ? "step" : undefined}
            >
              <span className="step-number">{number}</span>
              <span><strong>{title}</strong><small>{description}</small></span>
            </button>
          ))}
        </nav>

        <div className="product" aria-live="polite">
          <div className="product-bar">
            <span className="mini-brand"><i>O</i> Acme Knowledge</span>
            <span className="product-search">⌕&nbsp;&nbsp; Search company knowledge</span>
            <span className="avatar" aria-label="Signed in as Maya Chen">MC</span>
          </div>

          {step === 0 && (
            <div className="screen source-screen">
              <div className="screen-heading">
                <div><span className="crumb">Sources</span><h2>Connect your company knowledge</h2></div>
                <span className="sync-status">● All sources healthy</span>
              </div>
              <p className="screen-lede">Each repository stays authoritative. The hub keeps a permission-aware, read-only view.</p>
              <div className="source-list">
                {[
                  ["API", "acme/api", "48 concepts", "2 min ago"],
                  ["WEB", "acme/web", "31 concepts", "4 min ago"],
                  ["OPS", "acme/operations", "16 concepts", "Just now"],
                ].map(([icon, name, count, synced]) => (
                  <article className="source" key={name}>
                    <span className="repo-icon">{icon}</span>
                    <span><strong>{name}</strong><small>github.com/{name} · /okf</small></span>
                    <span className="source-count">{count}<small>Synced {synced}</small></span>
                    <span className="healthy">Healthy</span>
                  </article>
                ))}
              </div>
              <div className="outcome"><span>✓</span><p><strong>95 concepts connected</strong>Maya can browse them without copying or changing the repositories.</p></div>
            </div>
          )}

          {step === 1 && (
            <div className="screen editor-screen">
              <div className="editor-topline">
                <span>Policies&nbsp; / &nbsp;<strong>Incident communication</strong></span>
                <span className="saved">✓ Saved</span>
                <button className="publish">Publish</button>
              </div>
              <div className="editor-body">
                <aside><button className="outline-active">Incident communication</button><button>Before an incident</button><button>During an incident</button><button>After an incident</button></aside>
                <article className="document">
                  <span className="policy-tag">POLICY · DRAFT</span>
                  <h2>Incident communication</h2>
                  <p className="document-summary">How Acme keeps customers and internal teams informed during a service incident.</p>
                  <h3>During an incident</h3>
                  <p>The incident lead appoints a communicator. Post a plain-language update every 30 minutes, even when there is no material change.</p>
                  <div className="reference"><span>↗</span><p><strong>Linked technical context</strong>Incident response · acme/api</p></div>
                </article>
                <aside className="details"><span>Owner</span><strong>Maya Chen</strong><span>Review</span><strong>Alex Morgan</strong><span>Visibility</span><strong>Everyone at Acme</strong></aside>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="screen search-screen">
              <p className="crumb">Search</p>
              <div className="search-query">⌕ <strong>incident communication</strong><kbd>⌘ K</kbd></div>
              <div className="results-heading"><strong>4 trusted results</strong><span>All sources⌄</span></div>
              <div className="results">
                <article className="result featured"><span className="result-type native">COMPANY POLICY</span><h2>Incident communication</h2><p>How Acme keeps customers and internal teams informed during a service incident.</p><footer><span>Owned by Maya Chen</span><span>Verified today</span></footer></article>
                <article className="result"><span className="result-type imported">IMPORTED · ACME/API</span><h2>Incident response</h2><p>Roles, escalation paths, severity levels, and the technical response checklist.</p><footer><span>Source: acme/api</span><span>Synced 2 min ago</span></footer></article>
              </div>
              <div className="outcome"><span>✓</span><p><strong>One search, with provenance</strong>Maya can tell what is company-authored, what came from code, and whether each answer is current.</p></div>
            </div>
          )}

          <div className="demo-footer">
            <button className="back" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>← Back</button>
            <span>{step + 1} of {steps.length}</span>
            {step < steps.length - 1 ? (
              <button className="next" onClick={() => setStep(step + 1)}>Continue <span>→</span></button>
            ) : (
              <button className="next" onClick={() => setStep(0)}>Replay <span>↻</span></button>
            )}
          </div>
        </div>
      </section>

      <section className="validation">
        <p className="eyebrow">What we need to learn</p>
        <h2>Does this replace the copy-paste knowledge loop?</h2>
        <p>We’re looking for three engineering-led companies where one person can test this workflow with real repository knowledge and a real company policy.</p>
        <p className="guide-label">Conversation guide included with this prototype</p>
      </section>
    </main>
  );
}
