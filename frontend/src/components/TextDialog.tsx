import { useEffect, useRef, useState, type FormEvent } from 'react';

interface Props {
  title: string;
  text: string;
  onDone(text: string | null): void;
}

/** Asks for one line of text. */
export function TextDialog({ title, text, onDone }: Props) {
  const [value, setValue] = useState(text);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onDone(value);
  };

  return (
    <div className="veil" onMouseDown={(event) => event.target === event.currentTarget && onDone(null)}>
      <form className="dialog" onSubmit={submit} data-testid="text-dialog">
        <h2>{title}</h2>
        <input
          ref={input}
          value={value}
          maxLength={80}
          data-testid="text-input"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && onDone(null)}
        />
        <div className="actions">
          <button type="button" onClick={() => onDone(null)}>
            取消
          </button>
          <button type="submit" className="primary" data-testid="text-ok">
            确定
          </button>
        </div>
      </form>
    </div>
  );
}
