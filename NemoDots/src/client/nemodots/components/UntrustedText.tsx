import ReactMarkdown from 'react-markdown';
import { truncate } from '../format';

// Model-influenced text (finding claims, block details, recovery notes) is
// rendered through react-markdown, which escapes raw HTML. Links and images are
// reduced to plain text so untrusted content cannot navigate or load anything.

const MAX_CHARS = 2000;

const flatten = (tag: 'p' | 'strong') =>
  function Flat({ children }: { children?: React.ReactNode }) {
    const Tag = tag;
    return <Tag className="nd-md">{children}</Tag>;
  };

export function UntrustedText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={`nd-untrusted${className ? ` ${className}` : ''}`}>
      <ReactMarkdown
        components={{
          a: ({ children }) => <span className="nd-link-text">{children}</span>,
          img: ({ alt }) => <span>{alt}</span>,
          h1: flatten('strong'),
          h2: flatten('strong'),
          h3: flatten('strong'),
          h4: flatten('strong'),
          h5: flatten('strong'),
          h6: flatten('strong'),
        }}
      >
        {truncate(text, MAX_CHARS)}
      </ReactMarkdown>
    </div>
  );
}
