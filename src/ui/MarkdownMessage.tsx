import { useEffect, useRef } from 'react';
import { Component, MarkdownRenderer } from 'obsidian';
import { useApp } from '../context';

interface MarkdownMessageProps {
	content: string;
	sourcePath?: string;
}

export const MarkdownMessage = ({ content, sourcePath = '' }: MarkdownMessageProps) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const app = useApp();

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		el.empty();
		const component = new Component();
		component.load();
		void MarkdownRenderer.render(app, content, el, sourcePath, component);
		return () => {
			component.unload();
		};
	}, [app, content, sourcePath]);

	return <div ref={containerRef} className="ai-chat-markdown-body" />;
};
