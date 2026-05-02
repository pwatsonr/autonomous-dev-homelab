/**
 * Scripted prompter for ConsentManager tests. Implements SPEC-001-1-05
 * §"Files to Create/Modify".
 *
 * `scriptedPrompter([true, false, true])` returns a `promptFn` that
 * yields the scripted answers in order; subsequent calls beyond the
 * script length default to false (refusal).
 */

export interface ScriptedPrompter {
  promptFn: (msg: string) => Promise<boolean>;
  /** Messages observed by the prompter, in order. */
  messages: string[];
  /** Index of the next answer to deliver. */
  cursor(): number;
}

export function scriptedPrompter(answers: boolean[]): ScriptedPrompter {
  const messages: string[] = [];
  let i = 0;
  return {
    messages,
    cursor: () => i,
    promptFn: async (msg: string) => {
      messages.push(msg);
      if (i < answers.length) {
        const answer = answers[i] ?? false;
        i++;
        return answer;
      }
      i++;
      return false;
    },
  };
}
