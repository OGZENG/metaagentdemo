/**
 * Reference answers of the E3 probe questions (parallel.mjs). An answer is
 * correct if the expected result appears in the end of the aggregator's reply,
 * where it states its final answer. summarize.mjs re-checks the stored replies
 * with the same rules, so a fix here applies to recorded runs as well.
 */
export const ANSWERS = [
    /\b205\b/,
    /\b9\s*(h\b|hours?)/i,
    /not\s+(a\s+)?prime|isn.t\s+(a\s+)?prime|composite|17\s*[×x*·]\s*23/i,
    /\blower\b|\bless\b/i,
    /\bcarol\b/i,
    /2[,.\s]?842/,
    /3\s*\/\s*28|\\frac\{3\}\{28\}|0\.107/,
    /\b20\s*(m\/s|metres|meters)/i,
    /\bfriday\b/i,
    /\b72\b/
]

export const isCorrect = (index, output) => ANSWERS[index].test(String(output || '').slice(-300))
