import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { errText } from "./lib/errmsg";

interface State {
  error: unknown;
  /** Bumped on retry to remount the subtree from scratch. */
  attempt: number;
}

// A crash in a render or effect unmounts React's whole tree. In the Tauri shell
// there is no address bar to reload from, so without this the window just goes
// blank and the only way out is quitting the app. Catch it, show what happened,
// and offer both ways back: remount the UI, or reload the webview.
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("disk-solve: unhandled UI error", error, info.componentStack);
  }

  render() {
    const { error, attempt } = this.state;
    if (error == null) return <Fragment key={attempt}>{this.props.children}</Fragment>;
    return (
      <div className="crash">
        <div className="crash-card">
          <div className="crash-title">disk·solve hit an error</div>
          <div className="crash-msg">{errText(error)}</div>
          <div className="crash-actions">
            <button className="btn" onClick={() => this.setState({ error: null, attempt: attempt + 1 })}>Try again</button>
            <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
          </div>
          <div className="crash-hint">Either one starts the view over and rescans. Nothing on disk is changed.</div>
        </div>
      </div>
    );
  }
}
