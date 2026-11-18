'use client';
// "Select all" for a list of row checkboxes in the same form (the leads list, the unassigned
// queue). It ticks or clears every enabled row box named `name` on the current page, shows a
// mixed state when only some are ticked, and fires the form's change event so counters such as
// "3 selected" stay right. The server still checks every lead.
import { useEffect, useRef, useState } from 'react';

export function SelectAll({
  name,
  label = 'Select all on this page',
}: {
  name: string;
  label?: string;
}) {
  const box = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ all: boolean; some: boolean }>({ all: false, some: false });

  const rows = () =>
    [
      ...(box.current?.form?.querySelectorAll<HTMLInputElement>(
        `input[type="checkbox"][name="${name}"]`,
      ) ?? []),
    ].filter((r) => !r.disabled);

  useEffect(() => {
    const form = box.current?.form;
    if (!form) return;
    const sync = () => {
      const list = rows();
      const checked = list.filter((r) => r.checked).length;
      setState({ all: list.length > 0 && checked === list.length, some: checked > 0 });
    };
    sync();
    form.addEventListener('change', sync);
    return () => form.removeEventListener('change', sync);
    // `rows` reads the DOM each time; the form element is stable for the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    if (box.current) box.current.indeterminate = state.some && !state.all;
  }, [state]);

  return (
    <input
      ref={box}
      type="checkbox"
      aria-label={label}
      title={label}
      checked={state.all}
      onChange={(e) => {
        const on = e.target.checked;
        for (const r of rows()) r.checked = on;
        // Bubble a change so the form's own counter and this box update together.
        e.target.form?.dispatchEvent(new Event('change', { bubbles: true }));
      }}
      className="h-5 w-5 cursor-pointer accent-blue-900"
    />
  );
}
