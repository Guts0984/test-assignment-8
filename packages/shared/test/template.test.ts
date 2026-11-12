import { describe, expect, it } from 'vitest';
import { renderTemplate, unknownPlaceholders } from '../src';

const values = { customer_name: 'Олена', ticket_number: 'HD-1042' };

describe('renderTemplate', () => {
  it('substitutes both variables, repeated and with spaces inside the braces', () => {
    expect(
      renderTemplate('Hi {{customer_name}}, re {{ ticket_number }} / {{customer_name}}', values),
    ).toBe('Hi Олена, re HD-1042 / Олена');
  });
  it('is single-pass: values are never re-scanned (no injection via a hostile customer name)', () => {
    expect(
      renderTemplate('{{customer_name}} {{ticket_number}}', {
        customer_name: '{{ticket_number}}',
        ticket_number: 'HD-1',
      }),
    ).toBe('{{ticket_number}} HD-1');
    expect(
      renderTemplate('{{customer_name}}', { customer_name: '$& $1 \\1 $`', ticket_number: 'x' }),
    ).toBe('$& $1 \\1 $`');
  });
  it('leaves unknown placeholders and stray braces untouched', () => {
    expect(renderTemplate('{{password}} {customer_name} {{customer_name', values)).toBe(
      '{{password}} {customer_name} {{customer_name',
    );
  });
  it('lists unsupported placeholder names', () => {
    expect(unknownPlaceholders('{{customer_name}} {{password}} {{x}} {{password}}').sort()).toEqual(
      ['password', 'x'],
    );
    expect(unknownPlaceholders('no placeholders')).toEqual([]);
  });
});
