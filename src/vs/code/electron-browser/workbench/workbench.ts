/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-globals */

import { getPartsSplashColors } from './partsSplash.js';

(async function () {

	// Add a perf entry right from the top
	performance.mark('code/didStartRenderer');

	type ISandboxConfiguration = import('../../../base/parts/sandbox/common/sandboxTypes.js').ISandboxConfiguration;
	type ILoadResult<M, T extends ISandboxConfiguration> = import('../../../platform/window/electron-browser/window.js').ILoadResult<M, T>;
	type ILoadOptions<T extends ISandboxConfiguration> = import('../../../platform/window/electron-browser/window.js').ILoadOptions<T>;
	type INativeWindowConfiguration = import('../../../platform/window/common/window.ts').INativeWindowConfiguration;
	type IMainWindowSandboxGlobals = import('../../../base/parts/sandbox/electron-browser/globals.js').IMainWindowSandboxGlobals;
	type IDesktopMain = import('../../../workbench/electron-browser/desktop.main.js').IDesktopMain;
	type IPartsSplashPartBounds = import('../../../platform/theme/common/themeService.js').IPartsSplashPartBounds;

	const preloadGlobals = (window as unknown as { vscode: IMainWindowSandboxGlobals }).vscode; // defined by preload.ts
	const safeProcess = preloadGlobals.process;

	//#region Splash Screen Helpers

	function showSplash(configuration: INativeWindowConfiguration) {
		performance.mark('code/willShowPartsSplash');
		showDefaultSplash(configuration);
		performance.mark('code/didShowPartsSplash');
	}

	function showDefaultSplash(configuration: INativeWindowConfiguration) {
		let data = configuration.partsSplash;
		if (data) {
			if (configuration.autoDetectHighContrast && configuration.colorScheme.highContrast) {
				if ((configuration.colorScheme.dark && data.baseTheme !== 'hc-black') || (!configuration.colorScheme.dark && data.baseTheme !== 'hc-light')) {
					data = undefined; // high contrast mode has been turned by the OS -> ignore stored colors and layouts
				}
			} else if (configuration.autoDetectColorScheme) {
				if ((configuration.colorScheme.dark && data.baseTheme !== 'vs-dark') || (!configuration.colorScheme.dark && data.baseTheme !== 'vs')) {
					data = undefined; // OS color scheme is tracked and has changed
				}
			}
		}

		// developing an extension -> ignore stored layouts
		if (data && configuration.extensionDevelopmentPath) {
			data.layoutInfo = undefined;
		}

		// minimal color configuration (works with or without persisted data)
		let baseTheme;
		let shellBackground;
		let shellForeground;
		const splashColors = data ? getPartsSplashColors(data, window.document.hasFocus(), !!configuration.workspace) : undefined;
		if (data) {
			baseTheme = data.baseTheme;
			shellBackground = splashColors?.background;
			shellForeground = data.colorInfo.foreground;
		} else if (configuration.autoDetectHighContrast && configuration.colorScheme.highContrast) {
			if (configuration.colorScheme.dark) {
				baseTheme = 'hc-black';
				shellBackground = '#000000';
				shellForeground = '#FFFFFF';
			} else {
				baseTheme = 'hc-light';
				shellBackground = '#FFFFFF';
				shellForeground = '#000000';
			}
		} else if (configuration.autoDetectColorScheme) {
			if (configuration.colorScheme.dark) {
				baseTheme = 'vs-dark';
				shellBackground = '#1E1E1E';
				shellForeground = '#CCCCCC';
			} else {
				baseTheme = 'vs';
				shellBackground = '#FFFFFF';
				shellForeground = '#000000';
			}
		}

		const style = document.createElement('style');
		style.className = 'initialShellColors';
		window.document.head.appendChild(style);
		style.textContent = `body {	background-color: ${shellBackground}; color: ${shellForeground}; margin: 0; padding: 0; }`;

		// set zoom level as soon as possible
		if (typeof data?.zoomLevel === 'number' && typeof preloadGlobals?.webFrame?.setZoomLevel === 'function') {
			preloadGlobals.webFrame.setZoomLevel(data.zoomLevel);
		}

		// restore parts if possible (we might not always store layout info)
		if (data?.layoutInfo) {
			const { layoutInfo, colorInfo } = data;
			const modernUI = layoutInfo.modernUI === true;
			const floatingMargin = layoutInfo.modernUICompact === true ? 0 : 4;
			// The cluster perimeter is the same in both densities; only the inter-card gap differs.
			const floatingOuterMargin = 4;
			const floatingBorderWidth = 1;
			const floatingBorderRadius = 8;
			const contentTop = layoutInfo.titleBarHeight;
			const contentBottom = layoutInfo.statusBarHeight;

			const splash = document.createElement('div');
			splash.id = 'monaco-parts-splash';
			splash.className = baseTheme ?? 'vs-dark';

			if (layoutInfo.windowBorder && colorInfo.windowBorder) {
				const borderElement = document.createElement('div');
				borderElement.style.position = 'absolute';
				borderElement.style.width = 'calc(100vw - 2px)';
				borderElement.style.height = 'calc(100vh - 2px)';
				borderElement.style.zIndex = '1'; // allow border above other elements
				borderElement.style.border = `1px solid var(--window-border-color)`;
				borderElement.style.setProperty('--window-border-color', colorInfo.windowBorder);

				if (layoutInfo.windowBorderRadius) {
					borderElement.style.borderRadius = layoutInfo.windowBorderRadius;
				}

				splash.appendChild(borderElement);
			}

			const setBounds = (element: HTMLElement, bounds: { top: number; bottom?: number; left?: number; right?: number; width?: number; height?: number }) => {
				element.style.position = 'absolute';
				element.style.top = `${bounds.top}px`;
				if (typeof bounds.bottom === 'number') {
					element.style.bottom = `${bounds.bottom}px`;
				}
				if (typeof bounds.left === 'number') {
					element.style.left = `${bounds.left}px`;
				}
				if (typeof bounds.right === 'number') {
					element.style.right = `${bounds.right}px`;
				}
				if (typeof bounds.width === 'number') {
					element.style.width = `${bounds.width}px`;
				}
				if (typeof bounds.height === 'number') {
					element.style.height = `${bounds.height}px`;
				}
			};

			const setPartBounds = (element: HTMLElement, bounds: { top: number; left: number; width: number; height: number }) => {
				element.style.position = 'absolute';
				element.style.top = `${bounds.top}px`;
				element.style.left = `${bounds.left}px`;
				element.style.width = `${bounds.width}px`;
				element.style.height = `${bounds.height}px`;
			};

			const fallbackActivityBarBounds: IPartsSplashPartBounds | undefined = layoutInfo.modernUICompact === true && layoutInfo.activityBarWidth > 0 ? {
				top: contentTop + (contentTop === 0 ? floatingOuterMargin : 0),
				left: layoutInfo.sideBarSide === 'left' ? floatingOuterMargin : window.innerWidth - layoutInfo.activityBarWidth,
				width: Math.max(0, layoutInfo.activityBarWidth - floatingOuterMargin),
				height: window.innerHeight - contentTop - contentBottom - floatingOuterMargin - (contentTop === 0 ? floatingOuterMargin : 0),
			} : undefined;
			const compactPartBounds = layoutInfo.modernUICompact === true ? [
				layoutInfo.partBounds?.activityBar,
				layoutInfo.partBounds?.sideBar,
				layoutInfo.partBounds?.auxiliaryBar,
				layoutInfo.partBounds?.editor,
				layoutInfo.partBounds?.panel,
			].filter((bounds): bounds is IPartsSplashPartBounds => !!bounds) : [];
			const compactHorizontalBounds = layoutInfo.modernUICompact === true ? [
				layoutInfo.partBounds?.activityBar ?? fallbackActivityBarBounds,
				layoutInfo.partBounds?.sideBar,
				layoutInfo.partBounds?.auxiliaryBar,
				layoutInfo.partBounds?.editor,
				layoutInfo.partBounds?.panel,
			].filter((bounds): bounds is IPartsSplashPartBounds => !!bounds) : [];
			const compactClusterEdges = compactPartBounds.length > 0 && compactHorizontalBounds.length > 0 ? {
				left: Math.min(...compactHorizontalBounds.map(bounds => bounds.left)),
				right: Math.max(...compactHorizontalBounds.map(bounds => bounds.left + bounds.width)),
				top: Math.min(...compactPartBounds.map(bounds => bounds.top)),
				bottom: Math.max(...compactPartBounds.map(bounds => bounds.top + bounds.height)),
			} : undefined;

			// Without saved `partBounds` (they are cleared whenever the resolved bar widths differ
			// from the ones stored for the workspace) the cluster edges cannot be measured, so
			// derive ownership from the fallback order instead: the outermost visible card on each
			// side owns that edge, and every card spans the content region vertically.
			const fallbackClusterOrder: readonly ('activityBar' | 'sideBar' | 'editor' | 'auxiliaryBar')[] = layoutInfo.sideBarSide === 'left'
				? ['activityBar', 'sideBar', 'editor', 'auxiliaryBar']
				: ['auxiliaryBar', 'editor', 'sideBar', 'activityBar'];
			const fallbackClusterVisible = {
				activityBar: layoutInfo.activityBarWidth > 0,
				sideBar: layoutInfo.sideBarWidth > 0,
				editor: true,
				auxiliaryBar: layoutInfo.auxiliaryBarWidth > 0,
			};
			const fallbackLeftOwner = fallbackClusterOrder.find(part => fallbackClusterVisible[part]);
			const fallbackRightOwner = [...fallbackClusterOrder].reverse().find(part => fallbackClusterVisible[part]);
			const fallbackOuterEdgesFor = (part: 'activityBar' | 'sideBar' | 'editor' | 'auxiliaryBar') => ({
				left: fallbackLeftOwner === part,
				right: fallbackRightOwner === part,
				top: true,
				bottom: true,
			});
			const fallbackInsetFor = (part: 'activityBar' | 'sideBar' | 'editor' | 'auxiliaryBar', edge: 'left' | 'right' | 'top' | 'bottom') =>
				modernUI ? fallbackOuterEdgesFor(part)[edge] ? floatingOuterMargin : floatingMargin : 0;

			const railBorderColor = colorInfo.modernActivityBarBorder ?? colorInfo.surfaceBorder ?? colorInfo.agentsPanelBorder ?? colorInfo.editorGroupBorder ?? 'transparent';

			const applyFloatingCardStyles = (
				element: HTMLElement,
				backgroundColor: string | undefined,
				partBounds?: IPartsSplashPartBounds,
				fallbackOuterEdges = { left: true, right: true, top: true, bottom: true },
				compactBorderColor = colorInfo.surfaceBorder ?? colorInfo.agentsPanelBorder ?? colorInfo.editorGroupBorder ?? 'transparent'
			) => {
				element.style.boxSizing = 'border-box';
				if (layoutInfo.modernUICompact === true) {
					const outerEdges = partBounds?.outerEdges ?? (partBounds && compactClusterEdges ? {
						left: partBounds.left === compactClusterEdges.left,
						right: partBounds.left + partBounds.width === compactClusterEdges.right,
						top: partBounds.top === compactClusterEdges.top,
						bottom: partBounds.top + partBounds.height === compactClusterEdges.bottom,
					} : fallbackOuterEdges);
					element.style.borderStyle = 'solid';
					element.style.borderColor = compactBorderColor;
					element.style.borderWidth = `${outerEdges.top ? floatingBorderWidth : 0}px ${floatingBorderWidth}px ${floatingBorderWidth}px ${outerEdges.left ? floatingBorderWidth : 0}px`;
					element.style.borderRadius = [
						outerEdges.top && outerEdges.left ? floatingBorderRadius : 0,
						outerEdges.top && outerEdges.right ? floatingBorderRadius : 0,
						outerEdges.bottom && outerEdges.right ? floatingBorderRadius : 0,
						outerEdges.bottom && outerEdges.left ? floatingBorderRadius : 0,
					].map(radius => `${radius}px`).join(' ');
				} else {
					element.style.border = `${floatingBorderWidth}px solid ${colorInfo.agentsPanelBorder ?? colorInfo.editorGroupBorder ?? 'transparent'}`;
					element.style.borderRadius = `${floatingBorderRadius}px`;
				}
				element.style.backgroundColor = backgroundColor ?? colorInfo.editorBackground ?? colorInfo.background;
				element.style.overflow = 'hidden';
			};

			const contentHeight = `calc(100% - ${contentTop + contentBottom}px)`;
			const activityHeight = modernUI ? `calc(100% - ${contentTop + contentBottom + floatingMargin}px)` : contentHeight;
			const modernActivityBarBackground = (window.document.hasFocus()
				? colorInfo.modernActivityBarBackground
				: colorInfo.modernActivityBarInactiveBackground ?? colorInfo.modernActivityBarBackground)
				?? colorInfo.activityBarBackground;

			if (layoutInfo.auxiliaryBarWidth === Number.MAX_SAFE_INTEGER) {
				// if auxiliary bar is maximized, it goes as wide as the
				// window width but leaving room for activity bar
				layoutInfo.auxiliaryBarWidth = window.innerWidth - layoutInfo.activityBarWidth;
			} else {
				// otherwise adjust for other parts sizes if not maximized
				layoutInfo.auxiliaryBarWidth = Math.min(layoutInfo.auxiliaryBarWidth, window.innerWidth - (layoutInfo.activityBarWidth + layoutInfo.editorPartMinWidth + layoutInfo.sideBarWidth));
			}
			layoutInfo.sideBarWidth = Math.min(layoutInfo.sideBarWidth, window.innerWidth - (layoutInfo.activityBarWidth + layoutInfo.editorPartMinWidth + layoutInfo.auxiliaryBarWidth));

			// part: title
			if (layoutInfo.titleBarHeight > 0) {
				const titleDiv = document.createElement('div');
				titleDiv.style.position = 'absolute';
				titleDiv.style.width = '100%';
				titleDiv.style.height = `${layoutInfo.titleBarHeight}px`;
				titleDiv.style.left = '0';
				titleDiv.style.top = '0';
				titleDiv.style.backgroundColor = splashColors?.titleBarBackground ?? '';
				(titleDiv.style as CSSStyleDeclaration & { '-webkit-app-region': string })['-webkit-app-region'] = 'drag';
				splash.appendChild(titleDiv);

				if (!modernUI && colorInfo.titleBarBorder) {
					const titleBorder = document.createElement('div');
					titleBorder.style.position = 'absolute';
					titleBorder.style.width = '100%';
					titleBorder.style.height = '1px';
					titleBorder.style.left = '0';
					titleBorder.style.bottom = '0';
					titleBorder.style.borderBottom = `1px solid ${colorInfo.titleBarBorder}`;
					titleDiv.appendChild(titleBorder);
				}
			}

			// part: activity bar
			if (layoutInfo.activityBarWidth > 0) {
				const activityDiv = document.createElement('div');
				const activityBarBounds = layoutInfo.partBounds?.activityBar;
				if (modernUI && activityBarBounds) {
					setPartBounds(activityDiv, activityBarBounds);
				} else if (layoutInfo.modernUICompact === true) {
					setBounds(activityDiv, {
						top: contentTop + (contentTop === 0 ? floatingOuterMargin : 0),
						bottom: contentBottom + floatingOuterMargin,
						...(layoutInfo.sideBarSide === 'left' ? { left: floatingOuterMargin } : { right: floatingOuterMargin }),
						width: Math.max(0, layoutInfo.activityBarWidth - floatingOuterMargin),
					});
				} else {
					activityDiv.style.position = 'absolute';
					activityDiv.style.width = `${layoutInfo.activityBarWidth}px`;
					activityDiv.style.height = activityHeight;
					activityDiv.style.top = `${contentTop}px`;
					if (layoutInfo.sideBarSide === 'left') {
						activityDiv.style.left = '0';
					} else {
						activityDiv.style.right = '0';
					}
				}
				if (layoutInfo.modernUICompact === true) {
					applyFloatingCardStyles(activityDiv, modernActivityBarBackground, activityBarBounds, fallbackOuterEdgesFor('activityBar'), railBorderColor);
				} else if (modernUI) {
					// The rail is a card here too: rounded on the window side, and square where it
					// meets the primary side bar so the two read as one connected surface.
					const radius = `${floatingBorderRadius}px`;
					activityDiv.style.boxSizing = 'border-box';
					activityDiv.style.backgroundColor = modernActivityBarBackground ?? 'transparent';
					activityDiv.style.border = `${floatingBorderWidth}px solid ${railBorderColor}`;
					activityDiv.style.borderRadius = layoutInfo.sideBarWidth === 0 ? radius
						: layoutInfo.sideBarSide === 'left' ? `${radius} 0 0 ${radius}` : `0 ${radius} ${radius} 0`;
					activityDiv.style.overflow = 'hidden';
				} else {
					activityDiv.style.backgroundColor = `${colorInfo.activityBarBackground}`;
				}
				splash.appendChild(activityDiv);

				if (!modernUI && colorInfo.activityBarBorder) {
					const activityBorderDiv = document.createElement('div');
					activityBorderDiv.style.position = 'absolute';
					activityBorderDiv.style.width = '1px';
					activityBorderDiv.style.height = '100%';
					activityBorderDiv.style.top = '0';
					if (layoutInfo.sideBarSide === 'left') {
						activityBorderDiv.style.right = '0';
						activityBorderDiv.style.borderRight = `1px solid ${colorInfo.activityBarBorder}`;
					} else {
						activityBorderDiv.style.left = '0';
						activityBorderDiv.style.borderLeft = `1px solid ${colorInfo.activityBarBorder}`;
					}
					activityDiv.appendChild(activityBorderDiv);
				}
			}

			// part: side bar
			if (layoutInfo.sideBarWidth > 0) {
				// The side bar meets the activity bar rail flush; with no rail it is the outermost
				// card on that edge and takes the cluster's outer gutter instead.
				const sideBarFallbackOuterEdges = fallbackOuterEdgesFor('sideBar');
				const sideBarClusterInset = modernUI && sideBarFallbackOuterEdges[layoutInfo.sideBarSide === 'left' ? 'left' : 'right'] ? floatingOuterMargin : 0;
				const sideDiv = document.createElement('div');
				if (modernUI && layoutInfo.partBounds?.sideBar) {
					setPartBounds(sideDiv, layoutInfo.partBounds.sideBar);
				} else if (layoutInfo.sideBarSide === 'left') {
					setBounds(sideDiv, {
						top: contentTop + (contentTop === 0 ? fallbackInsetFor('sideBar', 'top') : 0),
						bottom: contentBottom + fallbackInsetFor('sideBar', 'bottom'),
						left: layoutInfo.activityBarWidth + sideBarClusterInset,
						width: modernUI ? Math.max(0, layoutInfo.sideBarWidth - sideBarClusterInset - floatingBorderWidth * 2) : layoutInfo.sideBarWidth
					});
				} else {
					setBounds(sideDiv, {
						top: contentTop + (contentTop === 0 ? fallbackInsetFor('sideBar', 'top') : 0),
						bottom: contentBottom + fallbackInsetFor('sideBar', 'bottom'),
						right: layoutInfo.activityBarWidth + sideBarClusterInset,
						width: modernUI ? Math.max(0, layoutInfo.sideBarWidth - sideBarClusterInset - floatingBorderWidth * 2) : layoutInfo.sideBarWidth
					});
				}
				if (modernUI) {
					applyFloatingCardStyles(sideDiv, colorInfo.surfaceBackground ?? colorInfo.agentsPanelBackground ?? colorInfo.sideBarBackground, layoutInfo.partBounds?.sideBar, sideBarFallbackOuterEdges);
				} else {
					sideDiv.style.backgroundColor = `${colorInfo.sideBarBackground}`;
				}
				splash.appendChild(sideDiv);

				if (!modernUI && colorInfo.sideBarBorder) {
					const sideBorderDiv = document.createElement('div');
					sideBorderDiv.style.position = 'absolute';
					sideBorderDiv.style.width = '1px';
					sideBorderDiv.style.height = '100%';
					sideBorderDiv.style.top = '0';
					sideBorderDiv.style.right = '0';
					if (layoutInfo.sideBarSide === 'left') {
						sideBorderDiv.style.borderRight = `1px solid ${colorInfo.sideBarBorder}`;
					} else {
						sideBorderDiv.style.left = '0';
						sideBorderDiv.style.borderLeft = `1px solid ${colorInfo.sideBarBorder}`;
					}
					sideDiv.appendChild(sideBorderDiv);
				}
			}

			// part: auxiliary sidebar
			if (layoutInfo.auxiliaryBarWidth > 0) {
				const auxiliaryBarFallbackOuterEdges = fallbackOuterEdgesFor('auxiliaryBar');
				const auxSideDiv = document.createElement('div');
				if (modernUI && layoutInfo.partBounds?.auxiliaryBar) {
					setPartBounds(auxSideDiv, layoutInfo.partBounds.auxiliaryBar);
				} else if (layoutInfo.sideBarSide === 'left') {
					setBounds(auxSideDiv, {
						top: contentTop + (contentTop === 0 ? fallbackInsetFor('auxiliaryBar', 'top') : 0),
						bottom: contentBottom + fallbackInsetFor('auxiliaryBar', 'bottom'),
						right: fallbackInsetFor('auxiliaryBar', 'right'),
						width: modernUI ? Math.max(0, layoutInfo.auxiliaryBarWidth - fallbackInsetFor('auxiliaryBar', 'right') - floatingMargin - floatingBorderWidth * 2) : layoutInfo.auxiliaryBarWidth
					});
				} else {
					setBounds(auxSideDiv, {
						top: contentTop + (contentTop === 0 ? fallbackInsetFor('auxiliaryBar', 'top') : 0),
						bottom: contentBottom + fallbackInsetFor('auxiliaryBar', 'bottom'),
						left: fallbackInsetFor('auxiliaryBar', 'left'),
						width: modernUI ? Math.max(0, layoutInfo.auxiliaryBarWidth - fallbackInsetFor('auxiliaryBar', 'left') - floatingMargin - floatingBorderWidth * 2) : layoutInfo.auxiliaryBarWidth
					});
				}
				if (modernUI) {
					applyFloatingCardStyles(auxSideDiv, colorInfo.sideBarBackground, layoutInfo.partBounds?.auxiliaryBar, auxiliaryBarFallbackOuterEdges);
				} else {
					auxSideDiv.style.backgroundColor = `${colorInfo.sideBarBackground}`;
				}
				splash.appendChild(auxSideDiv);

				if (!modernUI && colorInfo.sideBarBorder) {
					const auxSideBorderDiv = document.createElement('div');
					auxSideBorderDiv.style.position = 'absolute';
					auxSideBorderDiv.style.width = '1px';
					auxSideBorderDiv.style.height = '100%';
					auxSideBorderDiv.style.top = '0';
					if (layoutInfo.sideBarSide === 'left') {
						auxSideBorderDiv.style.left = '0';
						auxSideBorderDiv.style.borderLeft = `1px solid ${colorInfo.sideBarBorder}`;
					} else {
						auxSideBorderDiv.style.right = '0';
						auxSideBorderDiv.style.borderRight = `1px solid ${colorInfo.sideBarBorder}`;
					}
					auxSideDiv.appendChild(auxSideBorderDiv);
				}
			}

			if (modernUI && (layoutInfo.partBounds?.editor || !layoutInfo.partBounds)) {
				const editorFallbackOuterEdges = fallbackOuterEdgesFor('editor');
				const editorDiv = document.createElement('div');
				if (layoutInfo.partBounds?.editor) {
					setPartBounds(editorDiv, layoutInfo.partBounds.editor);
				} else {
					const editorLeft = (layoutInfo.sideBarSide === 'left' ? layoutInfo.activityBarWidth + layoutInfo.sideBarWidth : layoutInfo.auxiliaryBarWidth) + fallbackInsetFor('editor', 'left');
					const editorRight = (layoutInfo.sideBarSide === 'left' ? layoutInfo.auxiliaryBarWidth : layoutInfo.activityBarWidth + layoutInfo.sideBarWidth) + fallbackInsetFor('editor', 'right');
					setBounds(editorDiv, {
						top: contentTop + (contentTop === 0 ? fallbackInsetFor('editor', 'top') : 0),
						bottom: contentBottom + fallbackInsetFor('editor', 'bottom'),
						left: editorLeft,
						right: editorRight
					});
				}
				applyFloatingCardStyles(editorDiv, colorInfo.editorBackground, layoutInfo.partBounds?.editor, editorFallbackOuterEdges, colorInfo.editorBorder ?? colorInfo.surfaceBorder ?? colorInfo.editorGroupBorder ?? 'transparent');
				splash.appendChild(editorDiv);
			}

			if (modernUI && layoutInfo.partBounds?.panel) {
				const panelDiv = document.createElement('div');
				setPartBounds(panelDiv, layoutInfo.partBounds.panel);
				applyFloatingCardStyles(panelDiv, colorInfo.panelBackground ?? colorInfo.editorBackground, layoutInfo.partBounds.panel);
				panelDiv.style.borderColor = colorInfo.modernPanelBorder ?? colorInfo.surfaceBorder ?? colorInfo.agentsPanelBorder ?? colorInfo.editorGroupBorder ?? 'transparent';
				splash.appendChild(panelDiv);
			}

			// part: statusbar
			if (layoutInfo.statusBarHeight > 0) {
				const statusDiv = document.createElement('div');
				statusDiv.style.position = 'absolute';
				statusDiv.style.width = '100%';
				statusDiv.style.height = `${layoutInfo.statusBarHeight}px`;
				statusDiv.style.bottom = '0';
				statusDiv.style.left = '0';
				statusDiv.style.backgroundColor = splashColors?.statusBarBackground ?? '';
				splash.appendChild(statusDiv);

				if (!modernUI && colorInfo.statusBarBorder) {
					const statusBorderDiv = document.createElement('div');
					statusBorderDiv.style.position = 'absolute';
					statusBorderDiv.style.width = '100%';
					statusBorderDiv.style.height = '1px';
					statusBorderDiv.style.top = '0';
					statusBorderDiv.style.borderTop = `1px solid ${colorInfo.statusBarBorder}`;
					statusDiv.appendChild(statusBorderDiv);
				}
			}

			window.document.body.appendChild(splash);
			// Lightchain: a branded loader over the splash until the workbench has restored
			// (opening or switching a project), removed in partsSplash.ts.
			const lcLoader = document.createElement('div');
			lcLoader.id = 'lightchain-loader';
			lcLoader.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:#07070D;transition:opacity .25s ease;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif';
			const lcStyle = document.createElement('style');
			lcStyle.textContent = '@keyframes lcPulse{0%,100%{opacity:.55;transform:scale(.96)}50%{opacity:1;transform:scale(1)}}@keyframes lcBar{0%{left:-40%}100%{left:100%}}';
			lcLoader.appendChild(lcStyle);
			const lcBox = document.createElement('div');
			lcBox.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:18px';
			const lcSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			lcSvg.setAttribute('viewBox', '0 0 1000 1000');
			lcSvg.setAttribute('width', '56');
			lcSvg.setAttribute('height', '56');
			lcSvg.style.cssText = 'color:#CCCEEF;animation:lcPulse 1.6s ease-in-out infinite';
			const lcPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			lcPath.setAttribute('fill', 'currentColor');
			lcPath.setAttribute('d', 'M929.437 533.9C929.497 533.783 929.559 533.67 929.618 533.554C981.975 430.679 985.185 330.511 938.659 251.499C897.213 181.11 821.175 135.872 722.323 121.898C660.552 44.947 582.578 3 499.681 3C427.832 3 359.681 34.514 302.57 93.0076C220.24 99.4384 152.272 131.3 106.859 185.89C48.0531 256.593 34.8916 355.976 69.8024 465.733C69.8408 465.857 69.8846 465.979 69.9249 466.102C69.8664 466.217 69.8024 466.332 69.7439 466.446C17.3869 569.321 14.177 669.489 60.7027 748.501C102.148 818.892 178.187 864.128 277.039 878.104C338.81 955.053 416.784 997 499.681 997C571.546 997 639.713 965.472 696.832 906.951C779.128 900.513 847.103 868.687 892.503 814.11C951.309 743.407 964.47 644.024 929.559 534.267C929.521 534.145 929.477 534.021 929.437 533.9ZM902.999 271.688C937.211 329.796 938.946 402.773 908.675 480.161C896.696 453.723 882.238 427.638 865.516 402.201L850.505 455.981C864.496 480.634 876.027 505.47 884.98 530.091C870.878 555.396 853.921 580.046 834.439 603.722C839.323 569.98 841.908 535.283 841.908 500.002C841.908 406.384 824.211 310.374 784.866 224.398C776.263 205.598 766.591 187.261 755.777 169.589C822.526 186.716 873.603 221.77 902.999 271.688ZM198.635 500.002C198.635 443.838 205.371 390.023 217.655 340.283C255.931 304.521 300.23 272.071 349.158 244.373C406.73 211.783 466.903 187.958 526.477 173.597C581.995 196.771 637.638 229.429 689.948 271.257C726.787 300.714 759.418 332.676 787.491 365.999C796.088 408.392 800.727 453.389 800.727 500.002C800.727 556.164 793.991 609.979 781.709 659.717C743.433 695.479 699.133 727.929 650.204 755.627C592.654 788.204 532.5 812.083 472.947 826.446C417.411 803.272 361.745 770.587 309.417 728.743H309.414C272.575 699.286 239.943 667.324 211.871 634.001C203.274 591.61 198.635 546.614 198.635 500.002ZM663.758 117.347C636.657 116.888 608.932 118.593 580.894 122.337L615.039 159.278C628.424 158.215 641.698 157.64 654.81 157.64C664.126 157.64 673.368 157.909 682.512 158.454C688.537 158.814 694.468 159.301 700.322 159.893C725.886 194.624 747.533 235.858 764.102 281.882C748.825 267.402 732.772 253.397 715.975 239.964C696.795 224.627 676.863 210.191 656.248 196.761C635.804 183.443 614.6 171.523 593.162 159.832C577.671 151.384 561.291 144.046 544.921 137.396C539.083 135.023 534.18 133.014 529.943 131.309C479.686 111.601 428.75 98.9007 378.99 94.0131C373.808 93.5059 368.679 93.1152 363.577 92.78C404.474 61.2032 450.729 43.377 499.681 43.377C560.165 43.377 616.527 70.5949 663.758 117.347ZM138.772 211.409C169.707 174.22 213.028 150.363 263.822 139.242C260.868 143.323 257.943 147.458 255.075 151.707C230.741 187.785 210.687 228.434 195.174 272.27L246.007 254.358C266.036 206.937 291.693 165.494 321.522 132.166C325.891 132.01 330.28 131.899 334.717 131.899C374.563 131.899 417.078 138.181 460.531 150.492C415.875 165.379 371.494 185.109 328.567 209.409C299.544 225.837 271.914 244.279 245.158 264.043C225.802 278.34 206.416 293.327 189.433 310.333C186.279 313.378 183.42 316.137 180.828 318.635C180.773 318.841 180.722 319.049 180.666 319.255C149.175 349.755 121.702 382.454 98.9806 416.611C82.3259 338.198 94.0505 265.176 138.772 211.409ZM96.3629 728.312C62.1505 670.206 60.4157 597.229 90.687 519.839C104.128 549.505 120.691 578.727 140.072 607.085L153.178 551.484C137.231 524.386 124.241 497.019 114.383 469.909C128.484 444.604 145.44 419.954 164.923 396.278C160.039 430.021 157.454 464.72 157.454 500.002C157.454 524.435 158.615 549.118 160.922 573.446C169.363 662.446 196.339 753.21 243.585 830.411C176.838 813.284 125.759 778.232 96.3629 728.312ZM335.552 882.605C338.51 882.655 341.456 882.734 344.427 882.734C370.088 882.734 396.276 880.8 422.727 877.075L388.021 840.46C363.853 842.55 340.053 842.934 316.85 841.546C310.825 841.188 304.893 840.701 299.04 840.109C273.474 805.376 251.827 764.142 235.258 718.114C250.536 732.596 266.592 746.603 283.391 760.036H283.387C321.764 790.722 362.319 817.134 403.935 838.819C403.867 838.828 403.8 838.835 403.732 838.842C420.862 847.606 442.109 857.812 462.516 865.811C469.675 868.617 475.413 870.892 480.114 872.776C526.89 890.159 574.138 901.447 620.371 905.987C625.555 906.496 630.683 906.885 635.787 907.22C594.887 938.797 548.632 956.623 499.681 956.623C439.177 956.623 382.794 929.385 335.552 882.605ZM860.59 788.591C829.651 825.783 786.328 849.662 735.523 860.783C738.483 856.695 741.415 852.551 744.286 848.293C767.82 813.406 787.396 774.271 802.69 732.085L751.829 749.173C732.026 795.122 706.919 835.349 677.832 867.845C634.196 869.395 587.036 863.185 538.705 849.479C583.402 834.587 627.831 814.915 670.794 790.591C701.949 772.957 731.348 753.457 758.704 732.444C758.663 732.542 758.627 732.643 758.587 732.741C773.21 721.274 790.287 707.161 805.213 692.92C817.429 681.263 824.63 674.552 828.836 670.704C856.111 643.105 880.134 613.829 900.381 583.39C917.036 661.802 905.311 734.826 860.59 788.591ZM516.742 317.63L523.292 453.786C523.678 461.797 530.359 468.129 538.538 468.235L637.302 469.509C649.494 469.666 656.714 482.95 650.049 492.961L518.896 689.956C510.489 702.583 490.478 696.746 490.478 681.667V547.078C490.478 538.703 483.554 531.914 475.012 531.914H369.763C357.553 531.914 350.145 518.712 356.708 508.618C386.107 463.397 451.349 363.467 488.505 309.813C496.855 297.755 516.041 303.072 516.742 317.63Z');
			lcSvg.appendChild(lcPath);
			const lcBar = document.createElement('div');
			lcBar.style.cssText = 'position:relative;width:160px;height:2px;border-radius:2px;overflow:hidden;background:rgba(204,206,239,0.1)';
			const lcFill = document.createElement('div');
			lcFill.style.cssText = 'position:absolute;top:0;width:40%;height:100%;border-radius:2px;background:linear-gradient(90deg,#DD00AC,#7130C3,#410093);animation:lcBar 1.1s ease-in-out infinite';
			lcBar.appendChild(lcFill);
			const lcName = document.createElement('div');
			const lcWs = configuration.workspace as { uri?: { path?: string } } | undefined;
			const lcFolder = lcWs?.uri?.path ? decodeURIComponent(lcWs.uri.path.split('/').filter(Boolean).pop() ?? '') : '';
			lcName.textContent = lcFolder ? `Opening ${lcFolder}` : 'Lightchain Studio';
			lcName.style.cssText = 'color:#7376AA;font-size:13px;letter-spacing:.01em';
			lcBox.append(lcSvg, lcBar, lcName);
			lcLoader.appendChild(lcBox);
			window.document.body.appendChild(lcLoader);
		}
	}

	//#endregion

	//#region Window Helpers

	async function load<M, T extends ISandboxConfiguration>(options: ILoadOptions<T>): Promise<ILoadResult<M, T>> {

		// Window Configuration from Preload Script
		const configuration = await resolveWindowConfiguration<T>();

		// Signal before import()
		options?.beforeImport?.(configuration);

		// Developer settings
		const { enableDeveloperKeybindings, removeDeveloperKeybindingsAfterLoad, developerDeveloperKeybindingsDisposable, forceDisableShowDevtoolsOnError } = setupDeveloperKeybindings(configuration, options);

		// NLS
		setupNLS<T>(configuration);

		// Compute base URL and set as global
		const baseUrl = new URL(`${fileUriFromPath(configuration.appRoot, { isWindows: safeProcess.platform === 'win32', scheme: 'vscode-file', fallbackAuthority: 'vscode-app' })}/out/`);
		globalThis._VSCODE_FILE_ROOT = baseUrl.toString();

		// Set product configuration as global (used e.g. to select the ASAR path in `amdX`)
		globalThis._VSCODE_PRODUCT_JSON = { ...configuration.product };

		// Dev only: CSS import map tricks
		setupCSSImportMaps<T>(configuration, baseUrl);

		// ESM Import
		try {
			let workbenchUrl: string;
			if (!!safeProcess.env['VSCODE_DEV'] && globalThis._VSCODE_USE_RELATIVE_IMPORTS) {
				workbenchUrl = '../../../workbench/workbench.desktop.main.js'; // for dev purposes only
			} else {
				workbenchUrl = new URL(`vs/workbench/workbench.desktop.main.js`, baseUrl).href;
			}

			const result = await import(workbenchUrl);
			if (developerDeveloperKeybindingsDisposable && removeDeveloperKeybindingsAfterLoad) {
				developerDeveloperKeybindingsDisposable();
			}

			return { result, configuration };
		} catch (error) {
			onUnexpectedError(error, enableDeveloperKeybindings && !forceDisableShowDevtoolsOnError);

			throw error;
		}
	}

	async function resolveWindowConfiguration<T extends ISandboxConfiguration>() {
		const timeout = setTimeout(() => { console.error(`[resolve window config] Could not resolve window configuration within 10 seconds, but will continue to wait...`); }, 10000);
		performance.mark('code/willWaitForWindowConfig');

		const configuration = await preloadGlobals.context.resolveConfiguration() as T;
		performance.mark('code/didWaitForWindowConfig');

		clearTimeout(timeout);

		return configuration;
	}

	function setupDeveloperKeybindings<T extends ISandboxConfiguration>(configuration: T, options: ILoadOptions<T>) {
		const {
			forceEnableDeveloperKeybindings,
			disallowReloadKeybinding,
			removeDeveloperKeybindingsAfterLoad,
			forceDisableShowDevtoolsOnError
		} = typeof options?.configureDeveloperSettings === 'function' ? options.configureDeveloperSettings(configuration) : {
			forceEnableDeveloperKeybindings: false,
			disallowReloadKeybinding: false,
			removeDeveloperKeybindingsAfterLoad: false,
			forceDisableShowDevtoolsOnError: false
		};

		const isDev = !!safeProcess.env['VSCODE_DEV'];
		const enableDeveloperKeybindings = Boolean(isDev || forceEnableDeveloperKeybindings);
		let developerDeveloperKeybindingsDisposable: Function | undefined = undefined;
		if (enableDeveloperKeybindings) {
			developerDeveloperKeybindingsDisposable = registerDeveloperKeybindings(disallowReloadKeybinding);
		}

		return {
			enableDeveloperKeybindings,
			removeDeveloperKeybindingsAfterLoad,
			developerDeveloperKeybindingsDisposable,
			forceDisableShowDevtoolsOnError
		};
	}

	function registerDeveloperKeybindings(disallowReloadKeybinding: boolean | undefined): Function {
		const ipcRenderer = preloadGlobals.ipcRenderer;

		const extractKey =
			function (e: KeyboardEvent) {
				return [
					e.ctrlKey ? 'ctrl-' : '',
					e.metaKey ? 'meta-' : '',
					e.altKey ? 'alt-' : '',
					e.shiftKey ? 'shift-' : '',
					e.keyCode
				].join('');
			};

		// Devtools & reload support
		const TOGGLE_DEV_TOOLS_KB = (safeProcess.platform === 'darwin' ? 'meta-alt-73' : 'ctrl-shift-73'); // mac: Cmd-Alt-I, rest: Ctrl-Shift-I
		const TOGGLE_DEV_TOOLS_KB_ALT = '123'; // F12
		const RELOAD_KB = (safeProcess.platform === 'darwin' ? 'meta-82' : 'ctrl-82'); // mac: Cmd-R, rest: Ctrl-R

		let listener: ((e: KeyboardEvent) => void) | undefined = function (e) {
			const key = extractKey(e);
			if (key === TOGGLE_DEV_TOOLS_KB || key === TOGGLE_DEV_TOOLS_KB_ALT) {
				ipcRenderer.send('vscode:toggleDevTools');
			} else if (key === RELOAD_KB && !disallowReloadKeybinding) {
				ipcRenderer.send('vscode:reloadWindow');
			}
		};

		window.addEventListener('keydown', listener);

		return function () {
			if (listener) {
				window.removeEventListener('keydown', listener);
				listener = undefined;
			}
		};
	}

	function setupNLS<T extends ISandboxConfiguration>(configuration: T): void {
		globalThis._VSCODE_NLS_MESSAGES = configuration.nls.messages;
		globalThis._VSCODE_NLS_LANGUAGE = configuration.nls.language;

		let language = configuration.nls.language || 'en';
		if (language === 'zh-tw') {
			language = 'zh-Hant';
		} else if (language === 'zh-cn') {
			language = 'zh-Hans';
		}

		window.document.documentElement.setAttribute('lang', language);
	}

	function onUnexpectedError(error: string | Error, showDevtoolsOnError: boolean): void {
		if (showDevtoolsOnError) {
			const ipcRenderer = preloadGlobals.ipcRenderer;
			ipcRenderer.send('vscode:openDevTools');
		}

		console.error(`[uncaught exception]: ${error}`);

		if (error && typeof error !== 'string' && error.stack) {
			console.error(error.stack);
		}
	}

	function fileUriFromPath(path: string, config: { isWindows?: boolean; scheme?: string; fallbackAuthority?: string }): string {

		// Since we are building a URI, we normalize any backslash
		// to slashes and we ensure that the path begins with a '/'.
		let pathName = path.replace(/\\/g, '/');
		if (pathName.length > 0 && pathName.charAt(0) !== '/') {
			pathName = `/${pathName}`;
		}

		let uri: string;

		// Windows: in order to support UNC paths (which start with '//')
		// that have their own authority, we do not use the provided authority
		// but rather preserve it.
		if (config.isWindows && pathName.startsWith('//')) {
			uri = encodeURI(`${config.scheme || 'file'}:${pathName}`);
		}

		// Otherwise we optionally add the provided authority if specified
		else {
			uri = encodeURI(`${config.scheme || 'file'}://${config.fallbackAuthority || ''}${pathName}`);
		}

		return uri.replace(/#/g, '%23');
	}

	function setupCSSImportMaps<T extends ISandboxConfiguration>(configuration: T, baseUrl: URL) {

		// DEV ---------------------------------------------------------------------------------------
		// DEV: This is for development and enables loading CSS via import-statements via import-maps.
		// DEV: For each CSS modules that we have we defined an entry in the import map that maps to
		// DEV: a blob URL that loads the CSS via a dynamic @import-rule.
		// DEV ---------------------------------------------------------------------------------------

		if (globalThis._VSCODE_DISABLE_CSS_IMPORT_MAP) {
			return; // disabled in certain development setups
		}

		if (Array.isArray(configuration.cssModules) && configuration.cssModules.length > 0) {
			performance.mark('code/willAddCssLoader');

			globalThis._VSCODE_CSS_LOAD = function (url) {
				const link = document.createElement('link');
				link.setAttribute('rel', 'stylesheet');
				link.setAttribute('type', 'text/css');
				link.setAttribute('href', url);

				window.document.head.appendChild(link);
			};

			const importMap: { imports: Record<string, string> } = { imports: {} };
			for (const cssModule of configuration.cssModules) {
				const cssUrl = new URL(cssModule, baseUrl).href;
				const jsSrc = `globalThis._VSCODE_CSS_LOAD('${cssUrl}');\n`;
				const blob = new Blob([jsSrc], { type: 'application/javascript' });
				importMap.imports[cssUrl] = URL.createObjectURL(blob);
			}

			const ttp = window.trustedTypes?.createPolicy('vscode-bootstrapImportMap', { createScript(value) { return value; }, });
			const importMapSrc = JSON.stringify(importMap, undefined, 2);
			const importMapScript = document.createElement('script');
			importMapScript.type = 'importmap';
			importMapScript.setAttribute('nonce', '0c6a828f1297');
			// @ts-expect-error
			importMapScript.textContent = ttp?.createScript(importMapSrc) ?? importMapSrc;
			window.document.head.appendChild(importMapScript);

			performance.mark('code/didAddCssLoader');
		}
	}

	//#endregion

	const { result, configuration } = await load<IDesktopMain, INativeWindowConfiguration>(
		{
			configureDeveloperSettings: function (windowConfig) {
				return {
					// disable automated devtools opening on error when running extension tests
					// as this can lead to nondeterministic test execution (devtools steals focus)
					forceDisableShowDevtoolsOnError: typeof windowConfig.extensionTestsPath === 'string' || windowConfig['enable-smoke-test-driver'] === true,
					// enable devtools keybindings in extension development window
					forceEnableDeveloperKeybindings: Array.isArray(windowConfig.extensionDevelopmentPath) && windowConfig.extensionDevelopmentPath.length > 0,
					removeDeveloperKeybindingsAfterLoad: true
				};
			},
			beforeImport: function (windowConfig) {

				// Show our splash as early as possible
				showSplash(windowConfig);

				// Code windows have a `vscodeWindowId` property to identify them
				Object.defineProperty(window, 'vscodeWindowId', {
					get: () => windowConfig.windowId
				});

				// It looks like browsers only lazily enable
				// the <canvas> element when needed. Since we
				// leverage canvas elements in our code in many
				// locations, we try to help the browser to
				// initialize canvas when it is idle, right
				// before we wait for the scripts to be loaded.
				window.requestIdleCallback(() => {
					const canvas = document.createElement('canvas');
					const context = canvas.getContext('2d');
					context?.clearRect(0, 0, canvas.width, canvas.height);
					canvas.remove();
				}, { timeout: 50 });

				// Track import() perf
				performance.mark('code/willLoadWorkbenchMain');
			}
		}
	);

	// Mark start of workbench
	performance.mark('code/didLoadWorkbenchMain');

	// Load workbench
	result.main(configuration);
}());
