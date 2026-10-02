import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';

const components: Components = {
  a: ({ children, href }) => <a href={href} rel="noreferrer noopener" target="_blank">{children}</a>,
};

// Raw HTML in the source is dropped, never rendered: the text comes from files MOS did not write.
export function Markdown({ children, inline = false }: { children: string; inline?: boolean }) {
  const rendered = <ReactMarkdown
    components={components}
    disallowedElements={inline ? ['p'] : undefined}
    skipHtml
    unwrapDisallowed
  >{children}</ReactMarkdown>;
  return inline ? <span className="suite-markdown">{rendered}</span> : <div className="suite-markdown">{rendered}</div>;
}
