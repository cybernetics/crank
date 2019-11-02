import {Repeater, SlidingBuffer} from "@repeaterjs/repeater";

// TODO: make this non-global?
declare global {
	namespace JSX {
		interface IntrinsicElements {
			[name: string]: any;
		}

		// typescript jsx children type checking is busted so we just opt out of it:
		// https://github.com/microsoft/TypeScript/issues/14729
		// https://github.com/microsoft/TypeScript/pull/29818
		type ElementChildrenAttribute = {};
	}
}

function isPromiseLike(value: any): value is PromiseLike<unknown> {
	return value != null && typeof value.then === "function";
}

function isIterable(value: any): value is Iterable<unknown> {
	return value != null && typeof value[Symbol.iterator] === "function";
}

function isIteratorOrAsyncIterator(
	value: any,
): value is
	| AsyncIterator<unknown, unknown, unknown>
	| Iterator<unknown, unknown, unknown> {
	return value != null && typeof value.next === "function";
}

export interface Props {
	[key: string]: any;
	children?: Iterable<Child>;
}

export interface IntrinsicProps {
	[key: string]: any;
	children?: (Node | string)[];
}

export type IntrinsicIterator = Iterator<
	Node | undefined,
	Node | void,
	IntrinsicProps
>;

export type IntrinsicFunction = (props: IntrinsicProps) => IntrinsicIterator;

export type Tag<TProps extends Props = Props> =
	| Component<TProps>
	| ControlTag
	| string;

export const ElementSigil: unique symbol = Symbol.for("crank.element");
export type ElementSigil = typeof ElementSigil;

export interface Element<T extends Tag = Tag, TProps extends Props = Props> {
	sigil: ElementSigil;
	tag: T;
	props: TProps;
}

export function isElement(value: any): value is Element {
	return value != null && value.sigil === ElementSigil;
}

export function* flattenChildren(
	childOrChildren: Child | Children,
): Iterable<Child> {
	if (isIterable(childOrChildren)) {
		for (const child of childOrChildren) {
			if (
				child == null ||
				typeof child === "string" ||
				typeof child === "number" ||
				typeof child === "boolean" ||
				isElement(child)
			) {
				yield child;
			} else if (isIterable(child)) {
				yield* flattenChildren(child);
			} else {
				throw new TypeError("Unknown child type");
			}
		}
	} else {
		yield childOrChildren;
	}
}

export function createElement<T extends Tag>(
	tag: T,
	props?: Props | null,
	...children: (Child | Children)[]
): Element<T>;
export function createElement<T extends Tag>(
	tag: T,
	props?: Props | null,
): Element<T> {
	props = Object.assign({}, props);
	if (arguments.length > 3) {
		props.children = flattenChildren(Array.from(arguments).slice(2));
	} else if (arguments.length > 2) {
		props.children = flattenChildren(arguments[2]);
	}

	return {sigil: ElementSigil, tag, props};
}

// TODO: rename to Node?
export type Child = Element | string | number | boolean | null | undefined;

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Children extends Iterable<Child | Children> {}

export type ViewChild = ComponentView | IntrinsicView | string | undefined;

// TODO: composition not inheritance
// TODO: use a left-child right-sibling tree
interface Fiber<T> {
	value: Child;
	node?: T;
	child?: Fiber<T>;
	sibling?: Fiber<T>;
	parent?: Fiber<T>;
}

export abstract class View {
	// TODO: parameterize Node
	node?: Node;
	parent?: View;
	tag!: Tag;
	env!: Environment;
	props!: Props | IntrinsicProps;
	protected controller!: Controller;
	protected iter?: ComponentIterator | IntrinsicIterator;
	protected result?:
		| IteratorResult<Element, Element | void>
		| IteratorResult<Node | undefined>;
	protected updating = false;
	// TODO: left-child right-sibling tree
	children: ViewChild[] = [];
	// TODO: cache this.nodes so we don’t have to treat this.nodes with kid gloves
	private _nodes: (Node | string)[] | undefined;
	get nodes(): (Node | string)[] {
		if (this._nodes === undefined) {
			let buffer: string | undefined;
			const nodes: (Node | string)[] = [];
			for (const child of this.children) {
				if (child !== undefined) {
					if (typeof child === "string") {
						buffer = buffer === undefined ? child : buffer + child;
					} else {
						if (buffer !== undefined) {
							nodes.push(buffer);
							buffer = undefined;
						}

						if (child instanceof IntrinsicView) {
							if (child.node !== undefined) {
								nodes.push(child.node);
							}
						} else if (child instanceof ComponentView) {
							nodes.push(...child.nodes);
						}
					}
				}
			}

			if (buffer !== undefined) {
				nodes.push(buffer);
			}

			this._nodes = nodes;
		}

		return this._nodes;
	}

	get nodeOrNodes(): (Node | string | undefined) | (Node | string)[] {
		if (this.nodes.length > 1) {
			return this.nodes;
		}

		return this.nodes[0];
	}

	protected intrinsicFor(tag: string | ControlTag): IntrinsicFunction {
		if (typeof tag === "string") {
			const intrinsic = this.env[tag];
			if (intrinsic == null) {
				return this.env[Default](tag);
			}

			return intrinsic;
		} else if (isControlTag(tag)) {
			const intrinsic = this.env[tag];
			if (intrinsic == null) {
				throw new Error("Unknown Tag");
			}

			return intrinsic;
		} else {
			throw new Error("Unknown Tag");
		}
	}

	private createViewChild(child: Child): ViewChild {
		if (child == null || typeof child === "boolean") {
			return undefined;
		} else if (typeof child === "string") {
			return child;
		} else if (typeof child === "number") {
			return child.toString();
		} else if (typeof child.tag === "function") {
			return new ComponentView(child as Element<Component>, this.env, this);
		} else if (child.tag === Root || typeof child.tag === "string") {
			return new IntrinsicView(child, this.env, this);
		} else {
			throw new TypeError("Unknown child type");
		}
	}

	abstract update(elem: Element): Promise<void> | void;

	protected updateChildren(children: Iterable<Child>): Promise<void> | void {
		this._nodes = undefined;
		const promises: Promise<void>[] = [];
		let i = 0;
		let view = this.children[i];
		for (const elem of children) {
			if (
				view === undefined ||
				elem === null ||
				typeof view !== "object" ||
				typeof elem !== "object" ||
				view.tag !== elem.tag
			) {
				if (typeof view === "object") {
					const p = view.unmount();
					if (p !== undefined) {
						promises.push(p);
					}
				}

				view = this.createViewChild(elem);
				this.children[i] = view;
			}

			if (
				typeof view === "object" &&
				elem !== null &&
				typeof elem === "object"
			) {
				const p = view.update(elem);
				if (p !== undefined) {
					promises.push(p);
				}
			}

			view = this.children[++i];
		}

		while (i < this.children.length) {
			if (typeof view === "object") {
				const p = view.unmount();
				if (p !== undefined) {
					promises.push(p);
				}
			}

			delete this.children[i];
			view = this.children[++i];
		}

		if (promises.length) {
			return Promise.all(promises).then(() => {});
		}
	}

	commit(): void {
		if (typeof this.tag === "function") {
			if (!this.updating && this.parent !== undefined) {
				this.parent.commit();
			}
		} else {
			const props = {...this.props, children: this.nodes};
			if (this.iter == null) {
				const intrinsic = this.intrinsicFor(this.tag);
				this.iter = intrinsic(props);
			}

			this.result = (this.iter as IntrinsicIterator).next(props);
			this.node = this.result.value;
		}

		this.updating = false;
	}

	abstract unmount(): Promise<void> | void;
}

export class Controller {
	mounted = true;
	constructor(private view: ComponentView) {}

	*[Symbol.iterator](): Generator<Props> {
		while (this.mounted) {
			yield this.view.props;
		}
	}

	[Symbol.asyncIterator](): AsyncGenerator<Props> {
		return this.view.subscribe();
	}

	refresh(): Promise<void> | void {
		return this.view.refresh();
	}
}

export type SyncComponentIterator = Iterator<
	Element,
	Element | void,
	// TODO: parameterize Node
	(Node | string)[] | Node | string
>;

export type AsyncComponentIterator = AsyncIterator<
	Element,
	Element | void,
	// TODO: parameterize Node
	(Node | string)[] | Node | string
>;

export function* createIterator(
	controller: Controller,
	tag: (this: Controller, props: Props) => Element,
): SyncComponentIterator {
	for (const props of controller) {
		yield tag.call(controller, props);
	}
}

export async function* createAsyncIterator(
	controller: Controller,
	tag: (this: Controller, props: Props) => PromiseLike<Element>,
): AsyncComponentIterator {
	for await (const props of controller) {
		yield tag.call(controller, props);
	}
}

export type ComponentIterator = AsyncComponentIterator | SyncComponentIterator;

export type Component<TProps extends Props = Props> = (
	this: Controller,
	props: TProps,
) => ComponentIterator | PromiseLike<Element> | Element;

interface Publication {
	push(value: Props): unknown;
	stop(): unknown;
}

class ComponentView extends View {
	tag: Component;
	props: Props;
	protected iter?: ComponentIterator;
	protected controller = new Controller(this);
	protected result?: IteratorResult<Element, Element | void>;
	private promise?: Promise<void>;
	private publications: Set<Publication> = new Set();
	constructor(
		elem: Element<Component>,
		public env: Environment,
		public parent: View,
	) {
		super();
		if (typeof elem.tag !== "function") {
			throw new TypeError("Tag mismatch");
		}

		this.tag = elem.tag;
		this.props = elem.props;
	}

	subscribe(): Repeater<Props> {
		return new Repeater(async (push, stop) => {
			const publication = {push, stop};
			this.publications.add(publication);
			await stop;
			this.publications.delete(publication);
		}, new SlidingBuffer(1));
	}

	private publish(): void {
		for (const publication of this.publications) {
			publication.push(this.props);
		}
	}

	// TODO: handle resultP rejecting
	private pull(resultP: Promise<IteratorResult<Element>>): Promise<void> {
		return resultP.then((result) => {
			const p = this.iterate(result);
			let nodeOrNodes:
				| (Node | string)[]
				| Node
				| string
				| Promise<(Node | string)[] | Node | string>;
			if (p === undefined) {
				this.commit();
				nodeOrNodes = this.nodeOrNodes!;
			} else {
				nodeOrNodes = p.then(() => {
					this.commit();
					return this.nodeOrNodes!;
				});
			}

			if (!result.done) {
				this.promise = this.pull(
					(this.iter as AsyncComponentIterator).next(nodeOrNodes),
				);
			}

			return Promise.resolve(nodeOrNodes).then(() => {});
		});
	}

	private iterate(result: IteratorResult<Element>): Promise<void> | void {
		this.result = result;
		if (this.result.value == null) {
			return this.updateChildren([]);
		} else if (this.result.value.sigil !== ElementSigil) {
			throw new TypeError("Element not returned");
		}

		return this.updateChildren([this.result.value]);
	}

	initialize(): Promise<void> | void {
		const value:
			| ComponentIterator
			| PromiseLike<Element>
			| Element = this.tag.call(this.controller, this.props);
		if (isIteratorOrAsyncIterator(value)) {
			this.iter = value;
			const result = this.iter.next();
			if (isPromiseLike(result)) {
				this.promise = this.pull(result);
				this.publish();
				return this.promise;
			} else {
				return this.iterate(result);
			}
		} else if (isPromiseLike(value)) {
			this.promise = this.pull(
				Promise.resolve(value).then((value) => ({value, done: false})),
			);
			this.iter = createAsyncIterator(this.controller, this.tag as any);
			return this.promise;
		} else {
			this.iter = createIterator(this.controller, this.tag as any);
			return this.updateChildren([value]);
		}
	}

	refresh(): Promise<void> | void {
		if (this.iter === undefined) {
			return this.initialize();
		}

		if (this.promise === undefined) {
			const result = this.iter.next(this.nodeOrNodes!) as IteratorResult<
				Element
			>;
			return this.iterate(result);
		} else {
			this.publish();
			return this.promise;
		}
	}

	update(elem: Element): Promise<void> | void {
		this.updating = true;
		if (this.tag !== elem.tag) {
			throw new TypeError("Tag mismatch");
		}

		this.props = elem.props;
		return this.refresh();
	}

	unmount(): Promise<void> | void {
		this.controller.mounted = false;
		for (const publication of this.publications) {
			publication.stop();
		}

		let result:
			| Promise<IteratorResult<Element>>
			| IteratorResult<Element>
			| undefined;
		if (this.result !== undefined && !this.result.done) {
			if (this.iter !== undefined && typeof this.iter.return === "function") {
				result = this.iter.return();
			}
		}

		if (isPromiseLike(result)) {
			return result.then((result) => {
				if (!result.done) {
					throw new Error("Zombie iterator");
				}

				this.result = result;
				return this.updateChildren([]);
			});
		}

		if (result !== undefined && !result.done) {
			throw new Error("Zombie iterator");
		}

		this.result = result;
		return this.updateChildren([]);
	}
}

// TODO: parameterize Node
export class IntrinsicView extends View {
	tag: string | ControlTag;
	props: IntrinsicProps;
	protected iter?: IntrinsicIterator;
	protected result?: IteratorResult<Node | undefined>;
	constructor(elem: Element, public env: Environment, public parent?: View) {
		super();
		if (typeof elem.tag !== "string" && !isControlTag(elem.tag)) {
			throw new TypeError("Tag mismatch");
		}

		this.tag = elem.tag;
		this.props = {...elem.props, children: []};
	}

	update(elem: Element): Promise<void> | void {
		if (this.tag !== elem.tag) {
			throw new TypeError("Tag mismatch");
		}

		const children = elem.props.children;
		const p = this.updateChildren(children == null ? [] : children);
		if (p !== undefined) {
			return p.then(() => this.commit());
		}

		this.commit();
	}

	unmount(): Promise<void> | void {
		if (this.result !== undefined && !this.result.done) {
			if (this.iter !== undefined && typeof this.iter.return === "function") {
				this.result = this.iter.return();
				if (!this.result.done) {
					throw new Error("Zombie iterator");
				}
			}
		}

		return this.updateChildren([]);
	}
}

function updateDOMProps(el: HTMLElement, props: Props): void {
	for (const [key, value] of Object.entries(props)) {
		if (key in el) {
			(el as any)[key] = value;
		} else {
			el.setAttribute(key.toLowerCase(), value);
		}
	}
}

// TODO: move createTextNode calls to environment
function updateDOMChildren(
	el: HTMLElement,
	children: (Node | string)[] = [],
): void {
	if (el.childNodes.length === 0) {
		const fragment = document.createDocumentFragment();
		for (let child of children) {
			if (typeof child === "string") {
				child = document.createTextNode(child);
			}

			fragment.appendChild(child);
		}

		el.appendChild(fragment);
		return;
	}

	let oldChild = el.firstChild;
	for (const newChild of children) {
		if (oldChild === null) {
			el.appendChild(
				typeof newChild === "string"
					? document.createTextNode(newChild)
					: newChild,
			);
		} else if (typeof newChild === "string") {
			if (oldChild.nodeType === Node.TEXT_NODE) {
				if (oldChild.nodeValue !== newChild) {
					oldChild.nodeValue = newChild;
				}

				oldChild = oldChild.nextSibling;
			} else {
				el.insertBefore(document.createTextNode(newChild), oldChild);
			}
		} else if (oldChild !== newChild) {
			el.insertBefore(newChild, oldChild);
		} else {
			oldChild = oldChild.nextSibling;
		}
	}

	while (oldChild !== null) {
		const nextSibling = oldChild.nextSibling;
		el.removeChild(oldChild);
		oldChild = nextSibling;
	}
}

export const Default = Symbol("Default");
export type Default = typeof Default;

export const Root = Symbol("Root");
export type Root = typeof Root;

// TODO: implement these control tags
export const Fragment = Symbol("Fragment");
export type Fragment = typeof Fragment;

export const Copy = Symbol("Copy");
export type Copy = typeof Copy;

export const Portal = Symbol("Portal");
export type Portal = typeof Portal;

const controlTags = new Set([Root, Fragment, Portal]);

export type ControlTag = Root | Fragment | Portal;
export function isControlTag(value: any): value is ControlTag {
	return controlTags.has(value);
}

// TODO: allow tags to define child intrinsics (for svg and stuff)
interface Environment {
	[Default](tag: string): IntrinsicFunction;
	[Root]?: IntrinsicFunction;
	[Portal]?: IntrinsicFunction;
	[Fragment]?: IntrinsicFunction;
	// TODO: allow tags to define child tags somehow
	[tag: string]: IntrinsicFunction;
}

const defaultEnv: Environment = {
	[Default](tag: string): never {
		throw new Error(
			`tag ${tag} does not exist and default intrinsic not provided`,
		);
	},
};

const domEnv: Environment = {
	[Default](tag: string): IntrinsicFunction {
		return function* defaultDOM({children, ...props}): IntrinsicIterator {
			const node = document.createElement(tag);
			while (true) {
				updateDOMProps(node, props);
				updateDOMChildren(node, children);
				({children, ...props} = yield node);
			}
		};
	},
	*[Root]({node, children}): IntrinsicIterator {
		try {
			while (true) {
				updateDOMChildren(node, children);
				({node, children} = yield node);
			}
		} finally {
			updateDOMChildren(node);
		}
	},
};

export class Renderer {
	views: WeakMap<Node, IntrinsicView> = new WeakMap();
	env: Environment = defaultEnv;

	constructor(envs: Partial<Environment>[]) {
		for (const env of envs) {
			this.extend(env);
		}
	}

	extend(env: Partial<Environment>): void {
		// TODO: use an iterator I think
		if (env[Default] != null) {
			this.env[Default] = env[Default]!;
		}

		if (env[Root] != null) {
			this.env[Root] = env[Root];
		}

		if (env[Fragment] != null) {
			this.env[Fragment] = env[Fragment];
		}

		if (env[Portal] != null) {
			this.env[Portal] = env[Portal];
		}

		for (const [tag, value] of Object.entries(env)) {
			if (value != null) {
				this.env[tag] = value;
			}
		}
	}

	render(
		elem: Element | null | undefined,
		node: HTMLElement,
	): Promise<IntrinsicView> | IntrinsicView | undefined {
		if (elem != null && elem.tag !== Root) {
			elem = createElement(Root, {node}, elem);
		}

		let view: IntrinsicView;
		if (this.views.has(node)) {
			view = this.views.get(node)!;
		} else if (elem == null) {
			return;
		} else {
			view = new IntrinsicView(elem, this.env);
			this.views.set(node, view);
		}

		let p: Promise<void> | void;
		if (elem == null) {
			p = view.unmount();
			this.views.delete(node);
		} else {
			p = view.update(elem);
		}

		if (p !== undefined) {
			return p.then(() => view);
		}

		return view;
	}
}

export const renderer = new Renderer([domEnv]);

export function render(
	elem: Element | null | undefined,
	node: HTMLElement,
): Promise<IntrinsicView> | IntrinsicView | undefined {
	return renderer.render(elem, node);
}