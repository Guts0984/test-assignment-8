import { describe, expect, it } from 'vitest';
import { keyFor } from './use-hotkeys';

const press = (key: string, code: string, shiftKey = false) => keyFor({ key, code, shiftKey });

describe('keyFor: shortcuts work on a Ukrainian layout too', () => {
  it('Latin keys are taken as typed', () => {
    expect(press('j', 'KeyJ')).toBe('j');
    expect(press('Enter', 'Enter')).toBe('Enter');
    expect(press(' ', 'Space')).toBe(' ');
    expect(press('?', 'Slash', true)).toBe('?');
  });
  it('the physical J / K / X keys work when the layout prints о / л / ч', () => {
    expect(press('о', 'KeyJ')).toBe('j');
    expect(press('л', 'KeyK')).toBe('k');
    expect(press('ч', 'KeyX')).toBe('x');
  });
  it('the physical slash key still means / and ? on a Cyrillic layout', () => {
    expect(press('.', 'Slash')).toBe('.'); // ASCII: taken as typed (another Latin layout may print "." there)
    expect(press('ю', 'Slash')).toBe('/');
    expect(press('Ю', 'Slash', true)).toBe('?');
  });
  it('another Cyrillic key is not a shortcut', () => {
    expect(press('в', 'KeyD')).toBe('в');
  });
});
