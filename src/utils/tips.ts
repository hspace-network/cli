const TIPS: string[] = [
  'You can change your model and API key with "settings" command.',
  "Scroll output with PageUp / PageDown (or Shift+Up/Down). Ctrl+G jumps back to live.",
  'Use "/ask <question>" to chat with the configured LLM.',
];

export function getRandomTip(): string {
  return TIPS[Math.floor(Math.random() * TIPS.length)]!;
}
