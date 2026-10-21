import { describe, expect, it } from "vitest";
import { layoutDependencyMap } from "@/pages/inventory/dependencyLayout";
import { csvToItems, parseCsv, parseImport } from "@/pages/inventory/importParse";

describe("import parsing", () => {
  it("parses quoted CSV fields, escaped quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n\n')).toEqual([["a", "b"], ["x, y", 'he said "hi"']]);
  });

  it("maps CSV rows to resource items with semicolon tags", () => {
    const res = csvToItems("name,kind,address,environment,tags\ndb-1,Database,10.0.0.5,Production,db; critical\nweb-1,server,,,");
    expect(res.error).toBeNull();
    expect(res.items).toEqual([
      { name: "db-1", kind: "database", address: "10.0.0.5", environment: "production", tags: ["db", "critical"] },
      { name: "web-1", kind: "server" },
    ]);
  });

  it("rejects CSV without required columns or with unknown columns", () => {
    expect(csvToItems("title,kind\nx,server").error).toMatch(/name and kind/);
    expect(csvToItems("name,kind,colour\nx,server,red").error).toMatch(/Unknown column/);
  });

  it("accepts JSON arrays and {items: [...]}", () => {
    expect(parseImport('[{"name":"a","kind":"server"}]').items).toHaveLength(1);
    expect(parseImport('{"items":[{"name":"a","kind":"api"},{"name":"b","kind":"api"}]}').items).toHaveLength(2);
    expect(parseImport("[1,2]").error).toMatch(/object/);
    expect(parseImport("{oops").error).toMatch(/Invalid JSON/);
    expect(parseImport("   ").error).toMatch(/Paste/);
  });

  it("layers dependency map nodes after what they depend on", () => {
    const { layerOf, layers } = layoutDependencyMap({
      nodes: [
        { id: "web", name: "web", kind: "application", status: "healthy" },
        { id: "api", name: "api", kind: "api", status: "healthy" },
        { id: "db", name: "db", kind: "database", status: "critical" },
      ],
      edges: [
        { id: "1", from: "web", to: "api", description: "" },
        { id: "2", from: "api", to: "db", description: "" },
        { id: "3", from: "web", to: "db", description: "" },
      ],
    });
    expect(layerOf.get("db")).toBe(0);
    expect(layerOf.get("api")).toBe(1);
    expect(layerOf.get("web")).toBe(2);
    expect(layers).toEqual([["db"], ["api"], ["web"]]);
  });
});
