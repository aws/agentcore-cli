import { useRef } from "react";
import { Text, useInput } from "ink";
import { useNavigate } from "react-router";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { Layout } from "./Layout";
import { Spinner } from "./ui/spinner";
import { CodeBlock } from "./ui/code-block";

export interface JsonDetailProps {
  // breadcrumb labels the screen (e.g. [..., "endpoint", "get", id, name]).
  breadcrumb: string[];
  // The query state driving the view, in react-query's vocabulary.
  isPending: boolean;
  error: Error | null;
  // data is the resource to render (already unwrapped from its response).
  data: unknown;
  // loadingLabel names what's loading (e.g. "Loading endpoint…").
  loadingLabel: string;
  onEscape?: () => void;
  onRetry?: () => void;
}

// JsonDetail is the shared "show me the raw resource" screen body: a scrollable
// pretty-printed JSON block framed by the standard Layout. Every harness
// resource (harness, version, endpoint) gets the same detail treatment. Esc pops
// back to wherever the user came from; jk/arrows scroll.
export function JsonDetail({
  breadcrumb,
  isPending,
  error,
  data,
  loadingLabel,
  onEscape,
  onRetry,
}: JsonDetailProps) {
  const navigate = useNavigate();
  const scrollRef = useRef<ScrollViewRef>(null);

  useInput((input, key) => {
    if (key.escape) {
      if (onEscape) onEscape();
      else navigate(-1);
      return;
    }
    if (input === "r" && error && onRetry) {
      onRetry();
      return;
    }
    if (key.upArrow || input === "k") {
      scrollRef.current?.scrollBy(-1);
    }
    if (key.downArrow || input === "j") {
      scrollRef.current?.scrollBy(1);
    }
  });

  return (
    <Layout
      breadcrumb={breadcrumb}
      keyHints={[
        { key: "↑↓/kj", label: "navigate" },
        ...(error && onRetry ? [{ key: "r", label: "retry" }] : []),
        { key: "esc", label: "back" },
        { key: "ctl+c", label: "quit" },
      ]}
    >
      {isPending ? (
        <Spinner label={loadingLabel} />
      ) : error ? (
        <Text color="red">Error: {error.message}</Text>
      ) : (
        <ScrollView ref={scrollRef}>
          <CodeBlock
            language="json"
            showLineNumbers={false}
            showBorder={false}
            code={JSON.stringify(data, null, 2)}
          />
        </ScrollView>
      )}
    </Layout>
  );
}
