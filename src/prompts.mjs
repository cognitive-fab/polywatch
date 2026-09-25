export function reviewPrompt({ task, units }) {
  const parts = units.map(u => [
    `### ${u.rel}`,
    '#### Changes made in this turn',
    ...u.edits.map((e, i) => e.before
      ? `Edit ${i + 1}\n--- before\n${e.before}\n+++ after\n${e.after}`
      : `Edit ${i + 1} (file written)\n${e.after}`),
    '#### Current file' + (u.truncated ? ' (truncated)' : ''),
    '```', u.current, '```',
  ].join('\n')).join('\n\n');
  return `You are reviewing code that an AI coding assistant just wrote. Find real defects, not style issues.

Look for: wrong logic, missing or wrong guard conditions, off-by-one errors, wrong state updates, unhandled error paths, race conditions, unsafe concurrency, broken invariants, security problems, and code that does not do what the request asked.

Report only defects you can point to in the code. Each issue must name the file, the line or function, and a specific claim someone can check.

Reply with one JSON object and nothing else:
{"verdict": "ACCEPT" or "REJECT", "confidence": <0..1>, "summary": "<one sentence>",
 "issues": [{"file": "<path>", "where": "<line or function>", "severity": "high" | "medium" | "low", "claim": "<specific, checkable statement>"}]}
Use REJECT when there is at least one high or medium severity defect.

===== REQUEST THE ASSISTANT WAS WORKING ON =====
${task || '(not available)'}

===== CHANGES =====
${parts}
`;
}

export function claimPrompt({ claim, excerpt, request }) {
  return `A reviewer made a specific claim about a defect in the code below. Decide whether the claim is correct by checking it against the code${request ? ' and against the request the code was written for. If the request rules out what the claim asks for (for example, it fixes the data model or says what not to track), the claim does not hold' : ''}.
${request ? `\n===== REQUEST THE CODE WAS WRITTEN FOR =====\n${request}\n===== END OF REQUEST =====\n` : ''}
Claim (${claim.severity}) in ${claim.file} at ${claim.where}:
${claim.claim}

Code (the cited file, whole or in excerpts, then excerpts of the other files changed in the same turn):
\`\`\`
${excerpt}
\`\`\`

Reply with one JSON object and nothing else:
{"holds": "yes" | "no" | "uncertain", "evidence": "<the lines or reasoning that settle it, one or two sentences>"}
`;
}

export function parseJson(text) {
  const t = String(text || '').replace(/```(?:json)?/g, '');
  // From each opening brace, parse up to its matching closing brace (skipping braces inside JSON
  // strings), so prose or code containing braces around the answer does not break parsing. Each
  // start costs one linear scan, instead of one JSON.parse per closing brace in the text.
  for (let s0 = t.indexOf('{'); s0 >= 0; s0 = t.indexOf('{', s0 + 1)) {
    const e = matchingBrace(t, s0);
    if (e < 0) continue;
    try { const v = JSON.parse(t.slice(s0, e + 1)); if (v && typeof v === 'object') return v; } catch {}
  }
  return null;
}

function matchingBrace(t, s0) {
  let depth = 0, inStr = false;
  for (let i = s0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}
