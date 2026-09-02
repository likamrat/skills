#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_QA_LIMITS,
  formatPptxQaReport,
  inspectPptxBytes,
} from "./pptx-package-qa.mjs";

const qaCli = fileURLToPath(new URL("pptx-package-qa.mjs", import.meta.url));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "fde-pptx-package-qa-"));
const PRESENTATION_NS =
  "http://schemas.openxmlformats.org/presentationml/2006/main";
const OFFICE_REL_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NS =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const REL_TYPES = {
  officeDocument: `${OFFICE_REL_NS}/officeDocument`,
  slide: `${OFFICE_REL_NS}/slide`,
  notesSlide: `${OFFICE_REL_NS}/notesSlide`,
};

let crcTable;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    crcTable[index] = value >>> 0;
  }
  return crcTable;
}

function crc32(bytes) {
  let value = 0xffffffff;
  const table = getCrcTable();
  for (const byte of bytes) {
    value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function u16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
}

function createZip(inputEntries, options = {}) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;

  for (const input of inputEntries) {
    const name = Buffer.from(input.name, "utf8");
    const localName = Buffer.from(input.localName ?? input.name, "utf8");
    const data = asBuffer(input.data ?? "");
    const method =
      input.method === "store" || input.method === undefined
        ? 0
        : input.method === "deflate"
          ? 8
          : input.method;
    const encoded = method === 8 ? deflateRawSync(data) : data;
    const compressed = input.compressedSuffix
      ? Buffer.concat([encoded, asBuffer(input.compressedSuffix)])
      : encoded;
    const flags = (input.flags ?? 0x0800) | (input.dataDescriptor ? 0x0008 : 0);
    const versionNeeded = input.versionNeeded ?? 20;
    const checksum = input.crc ?? crc32(data);
    const localExtra = asBuffer(input.localExtra ?? Buffer.alloc(0));
    const centralExtra = asBuffer(input.centralExtra ?? Buffer.alloc(0));
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(versionNeeded),
      u16(flags),
      u16(method),
      u16(0),
      u16(0),
      u32(input.dataDescriptor ? 0 : checksum),
      u32(input.dataDescriptor ? 0 : compressed.length),
      u32(input.dataDescriptor ? 0 : data.length),
      u16(localName.length),
      u16(localExtra.length),
      localName,
      localExtra,
      compressed,
      ...(input.dataDescriptor
        ? [
            u32(0x08074b50),
            u32(checksum),
            u32(compressed.length),
            u32(data.length),
          ]
        : []),
    ]);
    localRecords.push(local);

    const central = Buffer.concat([
      u32(0x02014b50),
      u16(versionNeeded),
      u16(versionNeeded),
      u16(flags),
      u16(method),
      u16(0),
      u16(0),
      u32(checksum),
      u32(input.centralCompressedSize ?? compressed.length),
      u32(input.centralUncompressedSize ?? data.length),
      u16(name.length),
      u16(centralExtra.length),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(input.localOffset ?? localOffset),
      name,
      centralExtra,
    ]);
    centralRecords.push(central);
    localOffset += local.length;
  }

  const localArea = Buffer.concat(localRecords);
  const centralArea = Buffer.concat(centralRecords);
  const entryCount = options.zip64 ? 0xffff : inputEntries.length;
  const centralOffset =
    (options.centralOffset ?? localArea.length) >>> 0;
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entryCount),
    u16(entryCount),
    u32(options.zip64 ? 0xffffffff : centralArea.length),
    u32(options.zip64 ? 0xffffffff : centralOffset),
    u16(0),
  ]);
  return Buffer.concat([localArea, centralArea, eocd]);
}

function xml(value) {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${value}`, "utf8");
}

function relationships(items) {
  return xml(
    `<Relationships xmlns="${PACKAGE_REL_NS}">${items
      .map(
        ({ id, target, targetMode, type }) =>
          `<Relationship Id="${id}" Type="${type}" Target="${target}"${
            targetMode ? ` TargetMode="${targetMode}"` : ""
          }/>`,
      )
      .join("")}</Relationships>`,
  );
}

function cleanParts(slideCount = 2) {
  const overrides = [
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
  ];
  const slideIds = [];
  const presentationRelationships = [];
  const parts = [];

  for (let index = 1; index <= slideCount; index += 1) {
    overrides.push(
      `<Override PartName="/ppt/slides/slide${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
      `<Override PartName="/ppt/notesSlides/notesSlide${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
    );
    slideIds.push(`<p:sldId id="${255 + index}" r:id="rId${index}"/>`);
    presentationRelationships.push({
      id: `rId${index}`,
      target: `slides/slide${index}.xml`,
      type: REL_TYPES.slide,
    });
    parts.push(
      {
        data: xml(
          `<p:sld xmlns:p="${PRESENTATION_NS}"><p:cSld/></p:sld>`,
        ),
        method: "deflate",
        name: `ppt/slides/slide${index}.xml`,
      },
      {
        data: relationships([
          {
            id: "rIdNotes",
            target: `../notesSlides/notesSlide${index}.xml`,
            type: REL_TYPES.notesSlide,
          },
        ]),
        method: "deflate",
        name: `ppt/slides/_rels/slide${index}.xml.rels`,
      },
      {
        data: xml(
          `<p:notes xmlns:p="${PRESENTATION_NS}"><p:cSld/></p:notes>`,
        ),
        method: "deflate",
        name: `ppt/notesSlides/notesSlide${index}.xml`,
      },
      {
        data: relationships([
          {
            id: "rIdSlide",
            target: `../slides/slide${index}.xml`,
            type: REL_TYPES.slide,
          },
        ]),
        method: "deflate",
        name: `ppt/notesSlides/_rels/notesSlide${index}.xml.rels`,
      },
    );
  }

  return [
    {
      data: xml(
        `<Types xmlns="${CONTENT_TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join("")}</Types>`,
      ),
      method: "store",
      name: "[Content_Types].xml",
    },
    {
      data: relationships([
        {
          id: "rIdOffice",
          target: "ppt/presentation.xml",
          type: REL_TYPES.officeDocument,
        },
      ]),
      dataDescriptor: true,
      method: "deflate",
      name: "_rels/.rels",
    },
    {
      data: xml(
        `<p:presentation xmlns:p="${PRESENTATION_NS}" xmlns:r="${OFFICE_REL_NS}"><p:sldIdLst>${slideIds.join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/></p:presentation>`,
      ),
      method: "deflate",
      name: "ppt/presentation.xml",
    },
    {
      data: relationships(presentationRelationships),
      method: "deflate",
      name: "ppt/_rels/presentation.xml.rels",
    },
    ...parts,
  ];
}

function replacePart(parts, name, replace) {
  return parts.map((part) =>
    part.name === name ? { ...part, data: replace(asBuffer(part.data)) } : part,
  );
}

function appendContentType(parts, markup) {
  return replacePart(parts, "[Content_Types].xml", (data) =>
    Buffer.from(
      data.toString("utf8").replace("</Types>", `${markup}</Types>`),
      "utf8",
    ),
  );
}

function findingCodes(report) {
  return new Set(report.findings.map((finding) => finding.code));
}

function assertInvalid(bytes, expectedCode) {
  const report = inspectPptxBytes(bytes);
  assert.equal(report.valid, false);
  assert.ok(
    findingCodes(report).has(expectedCode),
    `expected ${expectedCode}, received ${report.findings
      .map((finding) => finding.code)
      .join(", ")}`,
  );
  return report;
}

try {
  const cleanBytes = createZip(cleanParts());
  const clean = inspectPptxBytes(cleanBytes);
  assert.equal(clean.valid, true, JSON.stringify(clean.findings));
  assert.deepEqual(clean.findings, []);
  assert.deepEqual(clean.counts, {
    archiveEntries: 12,
    notes: 2,
    parts: 12,
    relationships: 7,
    slides: 2,
  });
  assert.deepEqual(
    clean.slides.map(({ index, notesPart, part }) => ({
      index,
      notesPart,
      part,
    })),
    [
      {
        index: 1,
        notesPart: "ppt/notesSlides/notesSlide1.xml",
        part: "ppt/slides/slide1.xml",
      },
      {
        index: 2,
        notesPart: "ppt/notesSlides/notesSlide2.xml",
        part: "ppt/slides/slide2.xml",
      },
    ],
  );
  assert.equal(
    clean.package.sha256,
    createHash("sha256").update(cleanBytes).digest("hex"),
  );
  assert.deepEqual(clean, inspectPptxBytes(cleanBytes));
  assert.equal(
    formatPptxQaReport(clean),
    `${JSON.stringify(clean)}\n`,
  );
  assert.deepEqual(
    clean.parts.map((part) => part.name),
    clean.parts.map((part) => part.name).toSorted(),
  );

  const hiddenParts = replacePart(
    cleanParts(),
    "ppt/slides/slide2.xml",
    (data) =>
      Buffer.from(data.toString("utf8").replace("<p:sld ", '<p:sld show="0" ')),
  );
  assertInvalid(createZip(hiddenParts), "HIDDEN_SLIDE_FORBIDDEN");

  const wrongSizeParts = replacePart(
    cleanParts(),
    "ppt/presentation.xml",
    (data) =>
      Buffer.from(data.toString("utf8").replace('cx="12192000"', 'cx="9144000"')),
  );
  assertInvalid(createZip(wrongSizeParts), "SLIDE_SIZE_INVALID");

  const reboundNamespaceParts = replacePart(
    cleanParts(),
    "ppt/presentation.xml",
    (data) =>
      Buffer.from(
        data
          .toString("utf8")
          .replace("<p:sldIdLst>", '<p:sldIdLst xmlns:p="urn:not-presentationml">'),
      ),
  );
  assertInvalid(createZip(reboundNamespaceParts), "SLIDE_LIST_INVALID");

  const outOfRangeSlideIdParts = replacePart(
    cleanParts(),
    "ppt/presentation.xml",
    (data) =>
      Buffer.from(data.toString("utf8").replace('id="256"', 'id="1"')),
  );
  assertInvalid(createZip(outOfRangeSlideIdParts), "SLIDE_ID_INVALID");

  const duplicateNumericSlideIdParts = replacePart(
    cleanParts(),
    "ppt/presentation.xml",
    (data) =>
      Buffer.from(data.toString("utf8").replace('id="257"', 'id="0256"')),
  );
  assertInvalid(createZip(duplicateNumericSlideIdParts), "SLIDE_ID_INVALID");

  const reusedNotesParts = replacePart(
    cleanParts(),
    "ppt/slides/_rels/slide2.xml.rels",
    (data) =>
      Buffer.from(data.toString("utf8").replace("notesSlide2.xml", "notesSlide1.xml")),
  );
  assertInvalid(createZip(reusedNotesParts), "SLIDE_NOTES_NOT_UNIQUE");

  const missingFirstNotesParts = replacePart(
    cleanParts(),
    "ppt/slides/_rels/slide1.xml.rels",
    () => relationships([]),
  );
  const missingFirstNotes = assertInvalid(
    createZip(missingFirstNotesParts),
    "SLIDE_NOTES_RELATIONSHIP_INVALID",
  );
  assert.equal(missingFirstNotes.counts.notes, 1);
  assert.equal(missingFirstNotes.slides[0].notesPart, null);
  assert.equal(
    missingFirstNotes.slides[1].notesPart,
    "ppt/notesSlides/notesSlide2.xml",
  );

  const nonReciprocalParts = replacePart(
    cleanParts(),
    "ppt/notesSlides/_rels/notesSlide2.xml.rels",
    (data) =>
      Buffer.from(data.toString("utf8").replace("slide2.xml", "slide1.xml")),
  );
  assertInvalid(
    createZip(nonReciprocalParts),
    "NOTES_SLIDE_RECIPROCAL_INVALID",
  );

  let orphanSlideParts = cleanParts();
  orphanSlideParts = appendContentType(
    orphanSlideParts,
    '<Override PartName="/ppt/slides/slide99.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
  );
  orphanSlideParts.push({
    data: xml(`<p:sld xmlns:p="${PRESENTATION_NS}"><p:cSld/></p:sld>`),
    method: "deflate",
    name: "ppt/slides/slide99.xml",
  });
  assertInvalid(createZip(orphanSlideParts), "ORPHAN_SLIDE_PART");

  let mediaParts = cleanParts();
  mediaParts = appendContentType(
    mediaParts,
    '<Default Extension="png" ContentType="image/png"/>',
  );
  mediaParts.push({
    data: Buffer.from("not-a-real-image"),
    method: "store",
    name: "ppt/media/image1.png",
  });
  assertInvalid(createZip(mediaParts), "MEDIA_PART_FORBIDDEN");

  let embeddedParts = cleanParts();
  embeddedParts = appendContentType(
    embeddedParts,
    '<Default Extension="bin" ContentType="application/octet-stream"/>',
  );
  embeddedParts.push({
    data: Buffer.from("MZ"),
    method: "store",
    name: "ppt/embeddings/payload.bin",
  });
  const embedded = assertInvalid(
    createZip(embeddedParts),
    "EMBEDDED_ACTIVE_CONTENT_FORBIDDEN",
  );
  assert.ok(findingCodes(embedded).has("EXECUTABLE_CONTENT_FORBIDDEN"));

  for (const [name, contentType] of [
    [
      "custom/hidden.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    ["custom/archive.zip", "application/zip"],
  ]) {
    let hiddenPackageParts = appendContentType(
      cleanParts(),
      `<Override PartName="/${name}" ContentType="${contentType}"/>`,
    );
    hiddenPackageParts.push({
      data: Buffer.from("nested package"),
      method: "deflate",
      name,
    });
    assertInvalid(
      createZip(hiddenPackageParts),
      "EMBEDDED_ACTIVE_CONTENT_FORBIDDEN",
    );
  }

  for (const [signature, expectedCode] of [
    [Buffer.from([0x50, 0x4b, 0x03, 0x04]), "EMBEDDED_ACTIVE_CONTENT_FORBIDDEN"],
    [
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      "EMBEDDED_ACTIVE_CONTENT_FORBIDDEN",
    ],
    [Buffer.from([0x4d, 0x5a]), "EXECUTABLE_CONTENT_FORBIDDEN"],
  ]) {
    let disguisedPayloadParts = appendContentType(
      cleanParts(),
      '<Override PartName="/custom/payload.dat" ContentType="text/plain"/>',
    );
    disguisedPayloadParts.push({
      data: signature,
      method: "store",
      name: "custom/payload.dat",
    });
    assertInvalid(createZip(disguisedPayloadParts), expectedCode);
  }

  for (const [name, contentType] of [
    ["ppt/vbaProject.bin", "application/vnd.ms-office.vbaProject"],
    ["ppt/oleObjects/oleObject1.bin", "application/vnd.openxmlformats-officedocument.oleObject"],
  ]) {
    let activeParts = appendContentType(
      cleanParts(),
      `<Default Extension="bin" ContentType="${contentType}"/>`,
    );
    activeParts.push({ data: Buffer.from("payload"), method: "store", name });
    assertInvalid(
      createZip(activeParts),
      "EMBEDDED_ACTIVE_CONTENT_FORBIDDEN",
    );
  }

  const activeXParts = [
    ...cleanParts(),
    {
      data: xml("<activeX/>"),
      method: "deflate",
      name: "ppt/activeX/activeX1.xml",
    },
  ];
  assertInvalid(
    createZip(activeXParts),
    "EMBEDDED_ACTIVE_CONTENT_FORBIDDEN",
  );

  let executableParts = appendContentType(
    cleanParts(),
    '<Default Extension="exe" ContentType="application/x-msdownload"/>',
  );
  executableParts.push({
    data: Buffer.from("MZ"),
    method: "store",
    name: "payload.exe",
  });
  assertInvalid(
    createZip(executableParts),
    "EXECUTABLE_CONTENT_FORBIDDEN",
  );

  const externalParts = replacePart(
    cleanParts(),
    "ppt/_rels/presentation.xml.rels",
    (data) =>
      Buffer.from(
        data
          .toString("utf8")
          .replace(
            "</Relationships>",
            `<Relationship Id="rIdExternal" Type="${OFFICE_REL_NS}/hyperlink" Target="https://example.invalid/" TargetMode="External"/></Relationships>`,
          ),
      ),
  );
  assertInvalid(
    createZip(externalParts),
    "EXTERNAL_RELATIONSHIP_FORBIDDEN",
  );

  const emptyTargetSegmentParts = replacePart(
    cleanParts(),
    "ppt/_rels/presentation.xml.rels",
    (data) =>
      Buffer.from(
        data.toString("utf8").replace("slides/slide1.xml", "slides//slide1.xml"),
      ),
  );
  assertInvalid(
    createZip(emptyTargetSegmentParts),
    "RELATIONSHIP_TARGET_INVALID",
  );

  const nonEmptyRelationshipParts = replacePart(
    cleanParts(),
    "_rels/.rels",
    (data) =>
      Buffer.from(
        data
          .toString("utf8")
          .replace("/></Relationships>", ">junk</Relationship></Relationships>"),
      ),
  );
  assertInvalid(
    createZip(nonEmptyRelationshipParts),
    "RELATIONSHIPS_ELEMENT_INVALID",
  );

  const remoteTemplateParts = [
    ...replacePart(
      cleanParts(),
      "ppt/_rels/presentation.xml.rels",
      (data) =>
        Buffer.from(
          data
            .toString("utf8")
            .replace(
              "</Relationships>",
              `<Relationship Id="rIdTemplate" Type="${OFFICE_REL_NS}/attachedTemplate" Target="template.xml"/></Relationships>`,
            ),
        ),
    ),
    {
      data: xml("<template/>"),
      method: "deflate",
      name: "ppt/template.xml",
    },
  ];
  assertInvalid(createZip(remoteTemplateParts), "REMOTE_TEMPLATE_FORBIDDEN");

  const malformedXmlParts = replacePart(
    cleanParts(),
    "ppt/presentation.xml",
    () =>
      Buffer.from(
        `<?xml version="1.0"?><!DOCTYPE p:presentation [<!ENTITY x SYSTEM "file:///etc/passwd">]><p:presentation xmlns:p="${PRESENTATION_NS}" xmlns:r="${OFFICE_REL_NS}">&x;</p:presentation>`,
      ),
  );
  assertInvalid(
    createZip(malformedXmlParts),
    "XML_CONSTRUCT_UNSUPPORTED",
  );

  const malformedThemeParts = [
    ...cleanParts(),
    {
      data: Buffer.from("<theme>"),
      method: "deflate",
      name: "ppt/theme/theme1.xml",
    },
  ];
  assertInvalid(createZip(malformedThemeParts), "XML_MALFORMED");

  for (const malformedXml of [
    "<?xml nope?><root/>",
    "<root>&#xFFFE;</root>",
    "<root>&#X41;</root>",
  ]) {
    const malformedReferenceParts = [
      ...cleanParts(),
      {
        data: Buffer.from(malformedXml),
        method: "deflate",
        name: "custom/malformed-reference.xml",
      },
    ];
    assert.equal(
      inspectPptxBytes(createZip(malformedReferenceParts)).valid,
      false,
      `malformed XML must fail: ${malformedXml}`,
    );
  }

  const invalidCharacterParts = replacePart(
    cleanParts(),
    "ppt/presentation.xml",
    (data) =>
      Buffer.from(data.toString("utf8").replace("<p:sldIdLst>", "\0<p:sldIdLst>")),
  );
  assertInvalid(
    createZip(invalidCharacterParts),
    "XML_CHARACTER_INVALID",
  );

  let uppercaseXmlParts = appendContentType(
    cleanParts(),
    '<Override PartName="/custom/malformed.dat" ContentType="APPLICATION/XML"/>',
  );
  uppercaseXmlParts.push({
    data: Buffer.from("<broken>"),
    method: "deflate",
    name: "custom/malformed.dat",
  });
  assertInvalid(createZip(uppercaseXmlParts), "XML_MALFORMED");

  const namespaceBombParts = [
    ...cleanParts(),
    {
      data: Buffer.from(
        `<root ${Array.from(
          { length: PACKAGE_QA_LIMITS.maxXmlAttributesPerElement + 1 },
          (_, index) => `xmlns:n${index}="urn:n${index}"`,
        ).join(" ")}/>`,
      ),
      method: "deflate",
      name: "custom/namespaces.xml",
    },
  ];
  assertInvalid(
    createZip(namespaceBombParts),
    "XML_ATTRIBUTE_LIMIT_EXCEEDED",
  );

  let contentTypedOrphanParts = appendContentType(
    cleanParts(),
    '<Override PartName="/custom/orphan.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
  );
  contentTypedOrphanParts.push({
    data: xml(`<p:sld xmlns:p="${PRESENTATION_NS}"><p:cSld/></p:sld>`),
    method: "deflate",
    name: "custom/orphan.xml",
  });
  assertInvalid(
    createZip(contentTypedOrphanParts),
    "ORPHAN_SLIDE_PART",
  );

  const wrongRelationshipsTypeParts = replacePart(
    cleanParts(),
    "[Content_Types].xml",
    (data) =>
      Buffer.from(
        data
          .toString("utf8")
          .replace(
            'Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"',
            'Extension="rels" ContentType="application/xml"',
          ),
      ),
  );
  assertInvalid(
    createZip(wrongRelationshipsTypeParts),
    "RELATIONSHIPS_CONTENT_TYPE_INVALID",
  );

  const orphanOverrideParts = appendContentType(
    cleanParts(),
    '<Override PartName="/custom/missing.dat" ContentType="text/plain"/>',
  );
  assertInvalid(
    createZip(orphanOverrideParts),
    "CONTENT_TYPE_OVERRIDE_ORPHANED",
  );

  const excessOverrideParts = appendContentType(
    cleanParts(),
    Array.from(
      { length: 20 },
      (_, index) =>
        `<Override PartName="/custom/missing-${index}.dat" ContentType="text/plain"/>`,
    ).join(""),
  );
  assertInvalid(
    createZip(excessOverrideParts),
    "CONTENT_TYPE_OVERRIDE_LIMIT_EXCEEDED",
  );

  let encodedPartNameParts = appendContentType(
    cleanParts(),
    '<Override PartName="/custom/My%20Part.dat" ContentType="text/plain"/>',
  );
  encodedPartNameParts = replacePart(
    encodedPartNameParts,
    "ppt/_rels/presentation.xml.rels",
    (data) =>
      Buffer.from(
        data
          .toString("utf8")
          .replace(
            "</Relationships>",
            `<Relationship Id="rIdCustom" Type="${OFFICE_REL_NS}/customXml" Target="../custom/My%20Part.dat"/></Relationships>`,
          ),
      ),
  );
  encodedPartNameParts.push({
    data: Buffer.from("encoded part name"),
    method: "deflate",
    name: "custom/My%20Part.dat",
  });
  assert.equal(
    inspectPptxBytes(createZip(encodedPartNameParts)).valid,
    true,
    "valid percent-encoded OPC part names must resolve without decoding ZIP names",
  );

  let nativeMetadataParts = appendContentType(
    cleanParts(),
    '<Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/ppt/printerSettings/printerSettings1.bin" ContentType="application/vnd.openxmlformats-officedocument.presentationml.printerSettings"/>',
  );
  nativeMetadataParts.push(
    {
      data: Buffer.from("thumbnail"),
      method: "deflate",
      name: "docProps/thumbnail.jpeg",
    },
    {
      data: Buffer.from("printer settings"),
      method: "deflate",
      name: "ppt/printerSettings/printerSettings1.bin",
    },
  );
  assert.equal(
    inspectPptxBytes(createZip(nativeMetadataParts)).valid,
    true,
    "native thumbnail and printer settings metadata must be allowed",
  );

  assertInvalid(
    createZip(cleanParts().filter((part) => part.name !== "[Content_Types].xml")),
    "CONTENT_TYPES_MISSING",
  );
  assertInvalid(
    createZip([
      { data: "a", name: "duplicate.txt" },
      { data: "b", name: "duplicate.txt" },
    ]),
    "ZIP_DUPLICATE_ENTRY",
  );
  assertInvalid(
    createZip([{ data: "escape", name: "../escape.xml" }]),
    "ZIP_PATH_INVALID",
  );
  assertInvalid(
    createZip([{ data: "secret", flags: 0x0801, name: "secret.xml" }]),
    "ZIP_ENCRYPTION_UNSUPPORTED",
  );
  assertInvalid(
    createZip([{ data: "zip64", name: "zip64.xml" }], { zip64: true }),
    "ZIP64_UNSUPPORTED",
  );
  assertInvalid(
    createZip([{ data: "unsupported", method: 12, name: "unsupported.xml" }]),
    "ZIP_COMPRESSION_UNSUPPORTED",
  );
  assertInvalid(
    createZip([
      {
        compressedSuffix: Buffer.from("trailing"),
        data: "deflate payload",
        method: "deflate",
        name: "trailing.xml",
      },
    ]),
    "ZIP_DEFLATE_TRAILING_DATA",
  );
  assertInvalid(
    createZip([
      {
        data: "new ZIP feature",
        name: "version.xml",
        versionNeeded: 45,
      },
    ]),
    "ZIP_VERSION_UNSUPPORTED",
  );
  assertInvalid(
    createZip([
      {
        centralUncompressedSize: PACKAGE_QA_LIMITS.maxEntryBytes + 1,
        data: "small",
        name: "oversized.xml",
      },
    ]),
    "ZIP_ENTRY_TOO_LARGE",
  );
  assertInvalid(
    createZip(
      Array.from({ length: 5 }, (_, index) => ({
        centralCompressedSize: 30 * 1024 * 1024,
        centralUncompressedSize: 30 * 1024 * 1024,
        data: "",
        name: `expanded-${index}.xml`,
      })),
    ),
    "ZIP_EXPANDED_SIZE_TOO_LARGE",
  );
  assertInvalid(
    createZip([
      {
        crc: crc32(Buffer.from("content")) ^ 0xffffffff,
        data: "content",
        name: "bad-crc.xml",
      },
    ]),
    "ZIP_CRC_MISMATCH",
  );
  assertInvalid(
    createZip([{ data: "bad offset", localOffset: 123_456, name: "offset.xml" }]),
    "ZIP_LOCAL_HEADER_INVALID",
  );
  assertInvalid(
    createZip([{ data: "bad central offset", name: "offset.xml" }], {
      centralOffset: 1,
    }),
    "ZIP_CENTRAL_DIRECTORY_INVALID",
  );
  assertInvalid(
    createZip([
      {
        data: Buffer.alloc(300_000),
        method: "deflate",
        name: "ratio.xml",
      },
    ]),
    "ZIP_COMPRESSION_RATIO_EXCEEDED",
  );
  assertInvalid(
    createZip(
      Array.from(
        { length: PACKAGE_QA_LIMITS.maxEntries + 1 },
        (_, index) => ({ data: "", name: `entry-${index}.xml` }),
      ),
    ),
    "ZIP_ENTRY_COUNT_INVALID",
  );

  const cleanPath = join(temporaryDirectory, "clean.pptx");
  const invalidPath = join(temporaryDirectory, "hidden.pptx");
  await Promise.all([
    writeFile(cleanPath, cleanBytes),
    writeFile(invalidPath, createZip(hiddenParts)),
  ]);
  const cleanCli = spawnSync(process.execPath, [qaCli, cleanPath], {
    encoding: "utf8",
  });
  assert.equal(cleanCli.status, 0, cleanCli.stderr);
  assert.deepEqual(JSON.parse(cleanCli.stdout), clean);
  assert.equal(cleanCli.stderr, "");

  const invalidCli = spawnSync(process.execPath, [qaCli, "--pretty", invalidPath], {
    encoding: "utf8",
  });
  assert.equal(invalidCli.status, 1);
  assert.equal(JSON.parse(invalidCli.stdout).valid, false);
  assert.equal(invalidCli.stderr, "");

  const missingCli = spawnSync(
    process.execPath,
    [qaCli, join(temporaryDirectory, "missing.pptx")],
    { encoding: "utf8" },
  );
  assert.equal(missingCli.status, 1);
  assert.equal(JSON.parse(missingCli.stdout).findings[0].code, "PACKAGE_READ_FAILED");

  const usageCli = spawnSync(process.execPath, [qaCli], { encoding: "utf8" });
  assert.equal(usageCli.status, 2);
  assert.match(usageCli.stderr, /^Usage:/);
  assert.equal(usageCli.stdout, "");
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

console.log(
  "PPTX package QA tests passed: clean package, OOXML policy, malformed ZIP, deterministic JSON, and CLI.",
);
