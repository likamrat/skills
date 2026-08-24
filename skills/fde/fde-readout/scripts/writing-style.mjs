const namedPatterns = [
  {
    rule: "throat-clearing",
    pattern:
      /^(?:this (?:report|document|deck) (?:provides|outlines|explores)|the purpose of this (?:report|document|deck) is|we are pleased to present|here'?s the thing|here'?s what i mean|let me be clear|i'?ll be honest|the uncomfortable truth is)\b/gim,
    suggestion: "Delete the setup and state the point.",
  },
  {
    rule: "banned-ai-vocabulary",
    pattern:
      /\b(?:delve|foster|leverage|utilize|facilitate|empower|streamline|robust|cutting-edge|paradigm shift|game[- ]changer|this is huge|this changes everything|tapestry|realm|beacon|multifaceted|meticulous|intricate|paramount|transformative|elevate|embark|supercharge|harness|ever-evolving)\b/gi,
    suggestion: "Replace the inflated word with the concrete action or mechanism.",
  },
  {
    rule: "empty-preface",
    pattern:
      /\b(?:it'?s worth noting|it'?s important to note|at the end of the day|when it comes to|at its core|in today'?s world|in the age of|in the world of|the reality is|the truth is|in terms of|with regard to|in order to|going forward|in this article|let'?s dive in)\b/gi,
    suggestion: "Cut the preface and begin with the claim.",
  },
  {
    rule: "often-empty-adverb",
    pattern:
      /(?:(?<!not\s)\bjust\b|\b(?:literally|honestly|simply|actually|truly|fundamentally|importantly|crucially|inherently|inevitably)\b)/gi,
    suggestion:
      "Remove the adverb unless it carries real emphasis, uncertainty, contrast, or voice.",
    profiles: ["report"],
  },
  {
    rule: "binary-contrast",
    pattern:
      /\b(?:it|this|the question)\s+(?:isn'?t|is not)\s+[^.!?\n]{1,80}[.!?]\s+(?:it|this)\s+is\s+/gi,
    suggestion: "State the positive claim directly.",
  },
  {
    rule: "faux-insight",
    pattern:
      /\b(?:this is the part most people skip|what most people get wrong|here'?s what nobody tells you|the part everyone misses)\b/gi,
    suggestion: "Remove the expert pose and make the claim stand on evidence.",
  },
  {
    rule: "colon-reveal",
    pattern:
      /\b(?:the best part|the detail that makes it work|the truth|the reality|the key):\s+[a-z]/gi,
    suggestion: "Rewrite the reveal as a plain sentence.",
  },
  {
    rule: "superficial-analysis",
    pattern: /,\s+(?:highlighting|underscoring|reflecting|showcasing)\b/gi,
    suggestion:
      "Name the consequence or mechanism instead of appending an interpretive -ing clause.",
  },
  {
    rule: "importance-puffery",
    pattern:
      /\b(?:stands as a testament|marks a pivotal moment|plays a vital role|solidifies its position|underscores its significance)\b/gi,
    suggestion: "State the fact and let the reader judge its importance.",
  },
  {
    rule: "interpretive-metadiscourse",
    pattern:
      /\b(?:that last part matters more than it sounds|the key point is|this is the key point|as you can see|this distinction matters|in other words)\b/gi,
    suggestion: "Delete the reader instruction or replace it with supporting evidence.",
  },
  {
    rule: "weasel-attribution",
    pattern:
      /\b(?:experts agree|industry reports suggest|many argue|widely regarded as|studies show)\b/gi,
    suggestion: "Name the source or remove the claim.",
  },
  {
    rule: "fake-strong-verb",
    pattern: /\b(?:serves as|acts as|functions as)\b/gi,
    suggestion: "Use is, has, or the direct action when clearer.",
  },
  {
    rule: "negative-listing",
    pattern: /(?:^|\n)\s*(?:not|no)\s+[^.\n]{2,80}[.!]\s+(?:not|no)\s+/gi,
    suggestion: "State the positive claim once.",
  },
  {
    rule: "dramatic-fragmentation",
    pattern:
      /\b(?:that'?s it\.\s*that'?s the whole thing|and\s+[^.!?\n]{1,40}[.!]\s+and\s+)/gi,
    suggestion:
      "Join the fragments into a complete sentence unless the cadence is genuinely the writer's.",
  },
  {
    rule: "rhetorical-setup",
    pattern: /\b(?:what if i told you|think about it|plot twist)\s*[:?]/gi,
    suggestion: "Drop the setup and make the point.",
  },
  {
    rule: "fake-profound-ending",
    pattern: /\bthe future isn'?t coming[.!]\s*it'?s already here\b/gi,
    suggestion: "Delete the mic-drop line and end on a concrete point or action.",
  },
  {
    rule: "summary-recap-ending",
    pattern: /^(?:in conclusion|ultimately|overall),?\s+/gim,
    suggestion: "End on the last concrete point, decision, or next action.",
  },
];

const emDash = String.fromCodePoint(0x2014);

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

function findBareSourceList(text) {
  const lines = text.split(/\r?\n/);
  let offset = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{1,6}\s+\S/.test(line)) {
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

function markRange(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== "\n" && characters[index] !== "\r") {
      characters[index] = " ";
    }
  }
}

export function maskLiteralContent(text) {
  const masked = [...text];
  const ranges = [];
  const patterns = [
    /^```[\s\S]*?^```[ \t]*$/gm,
    /^~~~[\s\S]*?^~~~[ \t]*$/gm,
    /`[^`\n]+`/g,
    /\]\((?:https?:\/\/|mailto:)[^)]+\)/gi,
    /^>.*$/gm,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  ranges
    .sort((left, right) => left[0] - right[0])
    .forEach(([start, end]) => markRange(masked, start, end));

  return masked.join("");
}

export function findWritingIssues(text, { profile = "report" } = {}) {
  const visibleText = maskLiteralContent(text);
  const issues = [];

  for (const { rule, pattern, suggestion, profiles } of namedPatterns) {
    if (profiles && !profiles.includes(profile)) continue;
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(visibleText)) !== null) {
      issues.push({
        rule,
        line: lineNumber(text, match.index),
        excerpt: match[0],
        suggestion,
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

  const emDashMatches = [...visibleText.matchAll(new RegExp(emDash, "g"))];
  for (const match of emDashMatches) {
    issues.push({
      rule: "em-dash",
      line: lineNumber(text, match.index),
      excerpt: emDash,
      suggestion: "Use a period, comma, colon, or parentheses.",
    });
  }

  if (profile === "report") {
    for (const match of visibleText.matchAll(/[!！](?=\s|$)/g)) {
      issues.push({
        rule: "exclamation-mark",
        line: lineNumber(text, match.index),
        excerpt: match[0],
        suggestion: "State the claim without simulated enthusiasm.",
      });
    }
  }

  return issues.sort(
    (left, right) => left.line - right.line || left.rule.localeCompare(right.rule),
  );
}
