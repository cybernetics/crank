import resolve from "@rollup/plugin-node-resolve";
import typescript from "rollup-plugin-typescript2";
import * as fs from "fs";
import * as path from "path";
import pkg from "./package.json";

function packageCJS() {
	return {
		name: "packageCJS",
		writeBundle({dir, format}) {
			fs.writeFileSync(
				path.join(__dirname, dir, "package.json"),
				JSON.stringify(
					{
						name: `${pkg.name}-${format}`,
						type: "commonjs",
						private: true,
					},
					null,
					2,
				),
			);
		},
	};
}

export default [
	{
		input: ["src/index.ts", "src/dom.ts", "src/html.ts"],
		output: {
			format: "esm",
			dir: "./",
			chunkFileNames: "dist/[hash].js",
			sourcemap: true,
		},
		plugins: [typescript(), resolve()],
	},
	{
		input: ["src/index.ts", "src/dom.ts", "src/html.ts"],
		output: {
			format: "cjs",
			dir: "cjs",
			sourcemap: true,
		},
		plugins: [typescript(), resolve(), packageCJS()],
	},
	{
		input: "umd.ts",
		output: {
			format: "umd",
			dir: "umd",
			sourcemap: true,
			name: "Crank",
		},
		plugins: [typescript(), resolve(), packageCJS()],
	},
];
