import { useApp } from '../context';
import { FindCandidate } from '../commands/slashCommands';

interface FindResultsMessageProps {
	query: string;
	candidates: FindCandidate[];
}

export const FindResultsMessage = ({ query, candidates }: FindResultsMessageProps) => {
	const app = useApp();

	const open = (title: string) => {
		const leaf = app.workspace.getLeaf('split');
		void leaf.openFile(app.metadataCache.getFirstLinkpathDest(title, '') ?? app.vault.getAbstractFileByPath(title + '.md') as any);
	};

	return (
		<div className="ai-chat-find-results">
			<p className="ai-chat-find-header">
				Found <strong>{candidates.length}</strong> note{candidates.length !== 1 ? 's' : ''} for <em>"{query}"</em>
			</p>
			<div className="ai-chat-find-list">
				{candidates.map(c => (
					<button
						key={c.title}
						className="ai-chat-find-candidate"
						onClick={() => open(c.title)}
						title={c.relevance || c.title}
					>
						<span className="ai-chat-find-candidate-body">
							<span className="ai-chat-find-candidate-title">[[{c.title}]]</span>
							{c.relevance && (
								<span className="ai-chat-find-candidate-relevance">{c.relevance}</span>
							)}
							{c.terms.length > 0 && (
								<span className="ai-chat-find-candidate-terms">
									{c.terms.map(t => <code key={t}>{t}</code>)}
								</span>
							)}
						</span>
					</button>
				))}
			</div>
		</div>
	);
};
