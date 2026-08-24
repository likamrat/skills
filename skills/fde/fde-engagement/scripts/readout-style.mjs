const phraseRules = [
  ["chatbot-greeting", /\b(?:certainly|great question|absolutely)[!,]/gi],
  [
    "rapid-landscape",
    /\bin today'?s (?:rapidly evolving|fast-paced) (?:world|landscape)\b/gi,
  ],
  ["unlock-potential", /\bunlock (?:the |its |your )?potential\b/gi],
  ["navigate-complexity", /\bnavigate the complexit(?:y|ies)\b/gi],
  ["seamless-integration", /\bseamless integration\b/gi],
  ["key-takeaways", /\bkey takeaways?\b/gi],
  ["road-ahead", /\bthe road ahead\b/gi],
  ["generic-heading", /^#{1,6}\s+(?:opportunities|challenges)\s*$/gim],
  [
    "throat-clearing",
    /^(?:this (?:report|document|deck) (?:provides|outlines|explores)|the purpose of this (?:report|document|deck) is|we are pleased to present|here'?s the thing|here'?s what i mean|let me be clear|i'?ll be honest|the uncomfortable truth is)\b/gim,
    "Delete the setup and state the point.",
  ],
  [
    "banned-ai-vocabulary",
    /\b(?:delve|foster|leverage|utilize|facilitate|empower|streamline|robust|cutting-edge|paradigm shift|game[- ]changer|this is huge|this changes everything|tapestry|realm|beacon|multifaceted|meticulous|intricate|paramount|transformative|elevate|embark|supercharge|harness|ever-evolving)\b/gi,
    "Replace the inflated word with the concrete action or mechanism.",
  ],
  [
    "empty-preface",
    /\b(?:it'?s worth noting|it'?s important to note|at the end of the day|when it comes to|at its core|in today'?s world|in the age of|in the world of|the reality is|the truth is|in terms of|with regard to|in order to|going forward|in this article|let'?s dive in)\b/gi,
    "Cut the preface and begin with the claim.",
  ],
  [
    "often-empty-adverb",
    /(?:(?<!not\s)\bjust\b|\b(?:literally|honestly|simply|actually|truly|fundamentally|importantly|crucially|inherently|inevitably)\b)/gi,
    "Remove the adverb unless it carries real emphasis, uncertainty, contrast, or voice.",
    ["report"],
  ],
  [
    "binary-contrast",
    /\b(?:it|this|the question)\s+(?:isn'?t|is not)\s+[^.!?\n]{1,80}[.!?]\s+(?:it|this)\s+is\s+/gi,
    "State the positive claim directly.",
  ],
  [
    "faux-insight",
    /\b(?:this is the part most people skip|what most people get wrong|here'?s what nobody tells you|the part everyone misses)\b/gi,
    "Remove the expert pose and make the claim stand on evidence.",
  ],
  [
    "colon-reveal",
    /\b(?:the best part|the detail that makes it work|the truth|the reality|the key):\s+[a-z]/gi,
    "Rewrite the reveal as a plain sentence.",
  ],
  [
    "superficial-analysis",
    /,\s+(?:highlighting|underscoring|reflecting|showcasing)\b/gi,
    "Name the consequence or mechanism instead of appending an interpretive -ing clause.",
  ],
  [
    "importance-puffery",
    /\b(?:stands as a testament|marks a pivotal moment|plays a vital role|solidifies its position|underscores its significance)\b/gi,
    "State the fact and let the reader judge its importance.",
  ],
  [
    "interpretive-metadiscourse",
    /\b(?:that last part matters more than it sounds|the key point is|this is the key point|as you can see|this distinction matters|in other words)\b/gi,
    "Delete the reader instruction or replace it with supporting evidence.",
  ],
  [
    "weasel-attribution",
    /\b(?:experts agree|industry reports suggest|many argue|widely regarded as|studies show)\b/gi,
    "Name the source or remove the claim.",
  ],
  [
    "fake-strong-verb",
    /\b(?:serves as|acts as|functions as)\b/gi,
    "Use is, has, or the direct action when clearer.",
  ],
  [
    "negative-listing",
    /(?:^|\n)\s*(?:not|no)\s+[^.\n]{2,80}[.!]\s+(?:not|no)\s+/gi,
    "State the positive claim once.",
  ],
  [
    "dramatic-fragmentation",
    /\b(?:that'?s it\.\s*that'?s the whole thing|and\s+[^.!?\n]{1,40}[.!]\s+and\s+)/gi,
    "Join the fragments into a complete sentence unless the cadence is genuinely the writer's.",
  ],
  [
    "rhetorical-setup",
    /\b(?:what if i told you|think about it|plot twist)\s*[:?]/gi,
    "Drop the setup and make the point.",
  ],
  [
    "fake-profound-ending",
    /\bthe future isn'?t coming[.!]\s*it'?s already here\b/gi,
    "Delete the mic-drop line and end on a concrete point or action.",
  ],
  [
    "summary-recap-ending",
    /^(?:in conclusion|ultimately|overall),?\s+/gim,
    "End on the last concrete point, decision, or next action.",
  ],
  [
    "unsupported-superlative",
    /\b(?:world-class|industry-leading|revolutionary|unprecedented)\b/gi,
  ],
  [
    "transient-repository-positioning",
    /\b(?:the first (?:role|collection)|first collection|future roles|more (?:roles|skills|collections)[^.!\n]*\bwill (?:follow|live|arrive|be added))\b/gi,
  ],
  [
    "transient-indexing-status",
    /\b(?:the )?listing (?:may|might|can) (?:return|show) [`]?404[`]? until\b/gi,
  ],
  [
    "vague-operating-system-metaphor",
    /\brole-specific operating systems?\b/gi,
  ],
  ["conversational-engine", /\bconversational engine\b/gi],
  ["compounding-learning", /\bcompounding learning\b/gi],
  ["stable-seam", /\bstable seams?\b/gi],
  ["product-leverage", /\b(?:product|expected) leverage\b/gi],
  ["trusted-outcome", /\btrusted production outcome\b/gi],
  ["catchphrase-close-loops", /\bclose both loops\b/gi],
  ["catchphrase-protect-trust", /\bprotect trust\b/gi],
];

const emDash = String.fromCodePoint(0x2014);

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

function defaultSuggestion(rule) {
  if (rule === "generic-heading") {
    return "Name the decision, finding, risk, or control in the heading.";
  }
  if (rule === "unsupported-superlative") {
    return "Add a named comparison source or remove the superlative.";
  }
  if (rule.startsWith("transient-")) {
    return "Describe current behavior and inventory without temporary status language.";
  }
  if (
    [
      "vague-operating-system-metaphor",
      "conversational-engine",
      "compounding-learning",
      "stable-seam",
      "product-leverage",
      "trusted-outcome",
      "catchphrase-close-loops",
      "catchphrase-protect-trust",
    ].includes(rule)
  ) {
    return "Replace the label with the actor, action, evidence, control, or consequence.";
  }
  return "Replace the stock phrase with a concrete claim supported by the artifact.";
}

function maskProtected(text) {
  return text
    .replace(/```[\s\S]*?```/g, (match) =>
      match.replace(/[^\n]/g, " "),
    )
    .replace(/`[^`\n]+`/g, (match) => " ".repeat(match.length))
    .replace(/^>.*$/gm, (match) => " ".repeat(match.length));
}

function findBareSourceList(text) {
  const lines = text.split(/\r?\n/);
  let offset = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{1,6}\s+(?:Sources|References|Further reading)\s*$/i.test(line)) {
      let links = 0;
      for (const candidate of lines.slice(index + 1)) {
        if (/^#{1,6}\s+/.test(candidate)) break;
        if (
          /^\s*[-*]\s+\[[^\]]+\]\([^)]+\)\s*$/.test(candidate) ||
          /^\s*[-*]\s+(?:[^:\n]+:\s*)?https?:\/\/\S+\s*$/.test(candidate)
        ) {
          links += 1;
        }
      }
      if (links >= 3) return { index: offset, heading: line };
    }
    offset += line.length + 1;
  }

  return undefined;
}

export function findStyleIssues(text, { profile = "report" } = {}) {
  const issues = [];
  const searchable = maskProtected(text);

  for (const [rule, pattern, suggestion, profiles] of phraseRules) {
    if (profiles && !profiles.includes(profile)) continue;
    pattern.lastIndex = 0;
    for (const match of searchable.matchAll(pattern)) {
      issues.push({
        rule,
        line: lineNumber(text, match.index ?? 0),
        excerpt: match[0],
        suggestion: suggestion ?? defaultSuggestion(rule),
      });
    }

    const bareSourceList = findBareSourceList(text);
    if (bareSourceList) {
      issues.push({
        rule: "bare-source-list",
        line: lineNumber(text, bareSourceList.index),
        excerpt: bareSourceList.heading,
        suggestion:
          "Cite each source where it supports a claim or explain why each source belongs.",
      });
    }
  }

  const emDashes = [...searchable.matchAll(new RegExp(emDash, "g"))];
  if (emDashes.length > 0) {
    issues.push({
      rule: "em-dash",
      line: lineNumber(text, emDashes[0].index ?? 0),
      excerpt: `${emDashes.length} em dash character(s)`,
      suggestion: "Use a period, comma, colon, or parentheses.",
    });
  }

  if (profile === "report") {
    const exclamations = [...searchable.matchAll(/!(?=\s|$)/g)];
    if (exclamations.length > 0) {
      issues.push({
        rule: "exclamation",
        line: lineNumber(text, exclamations[0].index ?? 0),
        excerpt: "!",
        suggestion: "State the claim without simulated enthusiasm.",
      });
    }

    const genericClaim =
      /\b(?:significant (?:opportunit(?:y|ies)|inefficienc(?:y|ies)|risk)|meaningful (?:impact|improvement|value|risk)|streamline operations|drive efficiencies|enhance productivity|comprehensive (?:solution|approach))\b/gi;
    for (const [index, line] of searchable.split("\n").entries()) {
      genericClaim.lastIndex = 0;
      if (!/\[[a-z0-9][a-z0-9-]*\]/i.test(line)) {
        for (const match of line.matchAll(genericClaim)) {
          issues.push({
            rule: "generic-evidence-free-claim",
            line: index + 1,
            excerpt: match[0],
            suggestion: "Name the observed mechanism and add its evidence ID.",
          });
        }
      }
    }
  }

  return issues;
}
