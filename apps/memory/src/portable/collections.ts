/** Frozen v1 contract. SQL columns map to domain fields; JSON TEXT remains verbatim text. */
import type { Database } from 'bun:sqlite';
import type { CollectionDescriptor, PortableRecord } from './format.ts';
import { assertPortableScalar } from './format.ts';

export const COLLECTIONS: readonly CollectionDescriptor[] = Object.freeze([
  Object.freeze({ name: 'memories', table: 'knowledge_nodes',
    fields: Object.freeze({"id":"id","content":"body","memory_type":"memoryType","source_type":"sourceType","importance":"importance","confidence":"confidence","platform":"platform","author":"author","created_at":"createdAt","updated_at":"updatedAt","last_accessed_at":"lastAccessedAt","access_count":"accessCount","mention_count":"mentionCount","last_mentioned_at":"lastMentionedAt","metadata_json":"metadataJson","embedding_text":"embeddingText","polarity":"polarity","project_id":"projectId","event_at":"eventAt","event_until":"eventUntil","content_hash":"contentHash"}),
    types: Object.freeze({"id":{"type":"INTEGER","nullable":false},"body":{"type":"TEXT","nullable":false},"memoryType":{"type":"TEXT","nullable":false},"sourceType":{"type":"TEXT","nullable":false},"importance":{"type":"REAL","nullable":false},"confidence":{"type":"REAL","nullable":false},"platform":{"type":"TEXT","nullable":true},"author":{"type":"TEXT","nullable":true},"createdAt":{"type":"TEXT","nullable":false},"updatedAt":{"type":"TEXT","nullable":true},"lastAccessedAt":{"type":"TEXT","nullable":false},"accessCount":{"type":"INTEGER","nullable":false},"mentionCount":{"type":"INTEGER","nullable":false},"lastMentionedAt":{"type":"TEXT","nullable":true},"metadataJson":{"type":"TEXT","nullable":false},"embeddingText":{"type":"TEXT","nullable":true},"polarity":{"type":"TEXT","nullable":true},"projectId":{"type":"TEXT","nullable":true},"eventAt":{"type":"TEXT","nullable":true},"eventUntil":{"type":"TEXT","nullable":true},"contentHash":{"type":"TEXT","nullable":true}}),
    primaryKey: Object.freeze(["id"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'archivedMemories', table: 'knowledge_nodes_archive',
    fields: Object.freeze({"id":"id","content":"body","memory_type":"memoryType","source_type":"sourceType","importance":"importance","confidence":"confidence","platform":"platform","author":"author","created_at":"createdAt","updated_at":"updatedAt","last_accessed_at":"lastAccessedAt","access_count":"accessCount","mention_count":"mentionCount","last_mentioned_at":"lastMentionedAt","metadata_json":"metadataJson","embedding_text":"embeddingText","polarity":"polarity","project_id":"projectId","event_at":"eventAt","event_until":"eventUntil","content_hash":"contentHash","archived_at":"archivedAt"}),
    types: Object.freeze({"id":{"type":"INTEGER","nullable":false},"body":{"type":"TEXT","nullable":false},"memoryType":{"type":"TEXT","nullable":false},"sourceType":{"type":"TEXT","nullable":false},"importance":{"type":"REAL","nullable":false},"confidence":{"type":"REAL","nullable":false},"platform":{"type":"TEXT","nullable":false},"author":{"type":"TEXT","nullable":false},"createdAt":{"type":"TEXT","nullable":false},"updatedAt":{"type":"TEXT","nullable":true},"lastAccessedAt":{"type":"TEXT","nullable":false},"accessCount":{"type":"INTEGER","nullable":false},"mentionCount":{"type":"INTEGER","nullable":false},"lastMentionedAt":{"type":"TEXT","nullable":true},"metadataJson":{"type":"TEXT","nullable":false},"embeddingText":{"type":"TEXT","nullable":true},"polarity":{"type":"TEXT","nullable":true},"projectId":{"type":"TEXT","nullable":true},"eventAt":{"type":"TEXT","nullable":true},"eventUntil":{"type":"TEXT","nullable":true},"contentHash":{"type":"TEXT","nullable":true},"archivedAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["id"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'memoryEdges', table: 'knowledge_edges',
    fields: Object.freeze({"id":"id","source_id":"sourceId","target_id":"targetId","relation":"relation","provenance":"provenance","source_node_id":"sourceNodeId","weight":"weight","created_at":"createdAt"}),
    types: Object.freeze({"id":{"type":"INTEGER","nullable":false},"sourceId":{"type":"INTEGER","nullable":false},"targetId":{"type":"INTEGER","nullable":false},"relation":{"type":"TEXT","nullable":false},"provenance":{"type":"TEXT","nullable":false},"sourceNodeId":{"type":"INTEGER","nullable":true},"weight":{"type":"REAL","nullable":false},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["id"]),
    references: Object.freeze([{"field":"targetId","collection":"memories","targetField":"id"},{"field":"sourceId","collection":"memories","targetField":"id"}]) }),
  Object.freeze({ name: 'revisions', table: 'memory_revisions',
    fields: Object.freeze({"id":"id","old_node_id":"oldNodeId","new_node_id":"newNodeId","revision_type":"revisionType","reason":"reason","similarity_score":"similarityScore","old_content":"oldContent","new_content":"newContent","editor":"editor","edit_source":"editSource","created_at":"createdAt","source_message_id":"sourceMessageId","source_platform":"sourcePlatform"}),
    types: Object.freeze({"id":{"type":"INTEGER","nullable":false},"oldNodeId":{"type":"INTEGER","nullable":false},"newNodeId":{"type":"INTEGER","nullable":true},"revisionType":{"type":"TEXT","nullable":false},"reason":{"type":"TEXT","nullable":true},"similarityScore":{"type":"REAL","nullable":true},"oldContent":{"type":"TEXT","nullable":true},"newContent":{"type":"TEXT","nullable":true},"editor":{"type":"TEXT","nullable":true},"editSource":{"type":"TEXT","nullable":true},"createdAt":{"type":"TEXT","nullable":false},"sourceMessageId":{"type":"TEXT","nullable":true},"sourcePlatform":{"type":"TEXT","nullable":true}}),
    primaryKey: Object.freeze(["id"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'mutations', table: 'memory_mutations',
    fields: Object.freeze({"request_id":"requestId","node_id":"nodeId","actor":"actor","payload_hash":"payloadHash","result_json":"resultJson","created_at":"createdAt"}),
    types: Object.freeze({"requestId":{"type":"TEXT","nullable":false},"nodeId":{"type":"INTEGER","nullable":false},"actor":{"type":"TEXT","nullable":false},"payloadHash":{"type":"TEXT","nullable":false},"resultJson":{"type":"TEXT","nullable":false},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["requestId"]),
    references: Object.freeze([{"field":"nodeId","collection":"memories","targetField":"id"}]) }),
  Object.freeze({ name: 'memorySources', table: 'memory_node_sources',
    fields: Object.freeze({"node_id":"nodeId","source_key":"sourceKey","kind":"kind","platform":"platform","external_id":"externalId","detail_json":"detailJson","created_at":"createdAt"}),
    types: Object.freeze({"nodeId":{"type":"INTEGER","nullable":false},"sourceKey":{"type":"TEXT","nullable":false},"kind":{"type":"TEXT","nullable":false},"platform":{"type":"TEXT","nullable":true},"externalId":{"type":"TEXT","nullable":true},"detailJson":{"type":"TEXT","nullable":false},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["nodeId","sourceKey"]),
    references: Object.freeze([{"field":"nodeId","collection":"memories","targetField":"id"}]) }),
  Object.freeze({ name: 'archivedMemorySources', table: 'memory_node_sources_archive',
    fields: Object.freeze({"node_id":"nodeId","source_key":"sourceKey","kind":"kind","platform":"platform","external_id":"externalId","detail_json":"detailJson","created_at":"createdAt"}),
    types: Object.freeze({"nodeId":{"type":"INTEGER","nullable":false},"sourceKey":{"type":"TEXT","nullable":false},"kind":{"type":"TEXT","nullable":false},"platform":{"type":"TEXT","nullable":true},"externalId":{"type":"TEXT","nullable":true},"detailJson":{"type":"TEXT","nullable":false},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["nodeId","sourceKey"]),
    references: Object.freeze([{"field":"nodeId","collection":"archivedMemories","targetField":"id"}]) }),
  Object.freeze({ name: 'sourceEvents', table: 'memory_source_events',
    fields: Object.freeze({"event_key":"eventKey","node_id":"nodeId","evidence_json":"evidenceJson","created_at":"createdAt"}),
    types: Object.freeze({"eventKey":{"type":"TEXT","nullable":false},"nodeId":{"type":"INTEGER","nullable":false},"evidenceJson":{"type":"TEXT","nullable":false},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["eventKey"]),
    references: Object.freeze([{"field":"nodeId","collection":"memories","targetField":"id"}]) }),
  Object.freeze({ name: 'concepts', table: 'concept_nodes',
    fields: Object.freeze({"concept_id":"conceptId","name":"name","ko_name":"koName","ko_aliases":"koAliases","en_aliases":"enAliases","description":"description","embedding_text":"embeddingText","is_tag":"isTag","is_classification_key":"isClassificationKey","is_classification_value":"isClassificationValue","tag_usage_count":"tagUsageCount","classification_usage_count":"classificationUsageCount","search_blacklist":"searchBlacklist","created_at":"createdAt","updated_at":"updatedAt"}),
    types: Object.freeze({"conceptId":{"type":"TEXT","nullable":false},"name":{"type":"TEXT","nullable":false},"koName":{"type":"TEXT","nullable":true},"koAliases":{"type":"TEXT","nullable":true},"enAliases":{"type":"TEXT","nullable":true},"description":{"type":"TEXT","nullable":true},"embeddingText":{"type":"TEXT","nullable":true},"isTag":{"type":"INTEGER","nullable":false},"isClassificationKey":{"type":"INTEGER","nullable":false},"isClassificationValue":{"type":"INTEGER","nullable":false},"tagUsageCount":{"type":"INTEGER","nullable":false},"classificationUsageCount":{"type":"INTEGER","nullable":false},"searchBlacklist":{"type":"INTEGER","nullable":false},"createdAt":{"type":"TEXT","nullable":false},"updatedAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["conceptId"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'people', table: 'persons',
    fields: Object.freeze({"person_id":"personId","display_name":"displayName","aliases":"aliases","external_refs":"externalRefs","birthday":"birthday","address":"address","gender":"gender","attributes_json":"attributesJson","embedding_text":"embeddingText","created_at":"createdAt","updated_at":"updatedAt"}),
    types: Object.freeze({"personId":{"type":"TEXT","nullable":false},"displayName":{"type":"TEXT","nullable":false},"aliases":{"type":"TEXT","nullable":true},"externalRefs":{"type":"TEXT","nullable":true},"birthday":{"type":"TEXT","nullable":true},"address":{"type":"TEXT","nullable":true},"gender":{"type":"TEXT","nullable":true},"attributesJson":{"type":"TEXT","nullable":false},"embeddingText":{"type":"TEXT","nullable":true},"createdAt":{"type":"TEXT","nullable":false},"updatedAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["personId"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'entityTypes', table: 'entity_types',
    fields: Object.freeze({"type_name":"typeName","ko_name":"koName","id_prefix":"idPrefix","created_at":"createdAt"}),
    types: Object.freeze({"typeName":{"type":"TEXT","nullable":false},"koName":{"type":"TEXT","nullable":true},"idPrefix":{"type":"TEXT","nullable":true},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["typeName"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'entities', table: 'entities',
    fields: Object.freeze({"entity_id":"entityId","type_name":"typeName","name":"name","ko_name":"koName","medium":"medium","created_by":"createdBy","external_refs":"externalRefs","created_at":"createdAt","updated_at":"updatedAt"}),
    types: Object.freeze({"entityId":{"type":"TEXT","nullable":false},"typeName":{"type":"TEXT","nullable":false},"name":{"type":"TEXT","nullable":false},"koName":{"type":"TEXT","nullable":true},"medium":{"type":"TEXT","nullable":true},"createdBy":{"type":"TEXT","nullable":true},"externalRefs":{"type":"TEXT","nullable":true},"createdAt":{"type":"TEXT","nullable":false},"updatedAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["entityId"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'entityAttributes', table: 'entity_attributes',
    fields: Object.freeze({"entity_id":"entityId","attr_key":"attrKey","attr_value":"attrValue","is_column":"isColumn"}),
    types: Object.freeze({"entityId":{"type":"TEXT","nullable":false},"attrKey":{"type":"TEXT","nullable":false},"attrValue":{"type":"TEXT","nullable":false},"isColumn":{"type":"INTEGER","nullable":false}}),
    primaryKey: Object.freeze(["entityId","attrKey"]),
    references: Object.freeze([{"field":"entityId","collection":"entities","targetField":"entityId"}]) }),
  Object.freeze({ name: 'memoryConceptLinks', table: 'node_concept_edges',
    fields: Object.freeze({"node_id":"nodeId","concept_id":"conceptId","role":"role","provenance":"provenance","source_node_id":"sourceNodeId","created_at":"createdAt"}),
    types: Object.freeze({"nodeId":{"type":"INTEGER","nullable":false},"conceptId":{"type":"TEXT","nullable":false},"role":{"type":"TEXT","nullable":false},"provenance":{"type":"TEXT","nullable":false},"sourceNodeId":{"type":"INTEGER","nullable":true},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["nodeId","conceptId","role"]),
    references: Object.freeze([{"field":"conceptId","collection":"concepts","targetField":"conceptId"},{"field":"nodeId","collection":"memories","targetField":"id"}]) }),
  Object.freeze({ name: 'memoryPersonLinks', table: 'node_person_edges',
    fields: Object.freeze({"node_id":"nodeId","person_id":"personId","relation":"relation","provenance":"provenance","source_node_id":"sourceNodeId","created_at":"createdAt"}),
    types: Object.freeze({"nodeId":{"type":"INTEGER","nullable":false},"personId":{"type":"TEXT","nullable":false},"relation":{"type":"TEXT","nullable":false},"provenance":{"type":"TEXT","nullable":false},"sourceNodeId":{"type":"INTEGER","nullable":true},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["nodeId","personId","relation"]),
    references: Object.freeze([{"field":"personId","collection":"people","targetField":"personId"},{"field":"nodeId","collection":"memories","targetField":"id"}]) }),
  Object.freeze({ name: 'conceptLinks', table: 'concept_edges',
    fields: Object.freeze({"source_concept_id":"sourceConceptId","target_concept_id":"targetConceptId","relation":"relation","provenance":"provenance","source_node_id":"sourceNodeId","weight":"weight","created_at":"createdAt","updated_at":"updatedAt"}),
    types: Object.freeze({"sourceConceptId":{"type":"TEXT","nullable":false},"targetConceptId":{"type":"TEXT","nullable":false},"relation":{"type":"TEXT","nullable":false},"provenance":{"type":"TEXT","nullable":false},"sourceNodeId":{"type":"INTEGER","nullable":true},"weight":{"type":"REAL","nullable":false},"createdAt":{"type":"TEXT","nullable":false},"updatedAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["sourceConceptId","targetConceptId","relation"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'entityConceptLinks', table: 'entity_concept_edges',
    fields: Object.freeze({"entity_id":"entityId","concept_id":"conceptId","role":"role","provenance":"provenance","source_node_id":"sourceNodeId","weight":"weight","created_at":"createdAt"}),
    types: Object.freeze({"entityId":{"type":"TEXT","nullable":false},"conceptId":{"type":"TEXT","nullable":false},"role":{"type":"TEXT","nullable":false},"provenance":{"type":"TEXT","nullable":false},"sourceNodeId":{"type":"INTEGER","nullable":true},"weight":{"type":"REAL","nullable":true},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["entityId","conceptId","role"]),
    references: Object.freeze([{"field":"conceptId","collection":"concepts","targetField":"conceptId"},{"field":"entityId","collection":"entities","targetField":"entityId"}]) }),
  Object.freeze({ name: 'entityRelations', table: 'entity_relation_edges',
    fields: Object.freeze({"source_type":"sourceType","source_id":"sourceId","target_type":"targetType","target_id":"targetId","relation":"relation","provenance":"provenance","source_node_id":"sourceNodeId","weight":"weight","created_at":"createdAt"}),
    types: Object.freeze({"sourceType":{"type":"TEXT","nullable":false},"sourceId":{"type":"TEXT","nullable":false},"targetType":{"type":"TEXT","nullable":false},"targetId":{"type":"TEXT","nullable":false},"relation":{"type":"TEXT","nullable":false},"provenance":{"type":"TEXT","nullable":false},"sourceNodeId":{"type":"INTEGER","nullable":true},"weight":{"type":"REAL","nullable":true},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["sourceType","sourceId","targetType","targetId","relation"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'hierarchy', table: 'hierarchy_edges',
    fields: Object.freeze({"source_type":"sourceType","source_id":"sourceId","target_type":"targetType","target_id":"targetId","relation":"relation","provenance":"provenance","source_node_id":"sourceNodeId","weight":"weight","created_at":"createdAt"}),
    types: Object.freeze({"sourceType":{"type":"TEXT","nullable":false},"sourceId":{"type":"TEXT","nullable":false},"targetType":{"type":"TEXT","nullable":false},"targetId":{"type":"TEXT","nullable":false},"relation":{"type":"TEXT","nullable":false},"provenance":{"type":"TEXT","nullable":false},"sourceNodeId":{"type":"INTEGER","nullable":true},"weight":{"type":"REAL","nullable":false},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["sourceType","sourceId","targetType","targetId","relation"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'projectVocabulary', table: 'project_vocabularies',
    fields: Object.freeze({"project_id":"projectId","term":"term","expanded_meaning":"expandedMeaning","added_at":"addedAt","added_by":"addedBy"}),
    types: Object.freeze({"projectId":{"type":"TEXT","nullable":false},"term":{"type":"TEXT","nullable":false},"expandedMeaning":{"type":"TEXT","nullable":false},"addedAt":{"type":"TEXT","nullable":false},"addedBy":{"type":"TEXT","nullable":true}}),
    primaryKey: Object.freeze(["projectId","term"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'synonyms', table: 'synonym_user_entries',
    fields: Object.freeze({"entry_id":"entryId","term":"term","synonym":"synonym","lang":"lang","created_at":"createdAt"}),
    types: Object.freeze({"entryId":{"type":"TEXT","nullable":false},"term":{"type":"TEXT","nullable":false},"synonym":{"type":"TEXT","nullable":false},"lang":{"type":"TEXT","nullable":false},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["entryId"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'classificationVocabulary', table: 'classify_vocab_user_entries',
    fields: Object.freeze({"entry_id":"entryId","type_name":"typeName","slot":"slot","value":"value","created_at":"createdAt"}),
    types: Object.freeze({"entryId":{"type":"TEXT","nullable":false},"typeName":{"type":"TEXT","nullable":false},"slot":{"type":"TEXT","nullable":false},"value":{"type":"TEXT","nullable":false},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["entryId"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'classificationOverrides', table: 'classify_vocab_overrides',
    fields: Object.freeze({"override_id":"overrideId","type_name":"typeName","slot":"slot","value":"value","kind":"kind","created_at":"createdAt"}),
    types: Object.freeze({"overrideId":{"type":"TEXT","nullable":false},"typeName":{"type":"TEXT","nullable":false},"slot":{"type":"TEXT","nullable":false},"value":{"type":"TEXT","nullable":false},"kind":{"type":"TEXT","nullable":false},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["overrideId"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'relationNames', table: 'relation_name_user_entries',
    fields: Object.freeze({"entry_id":"entryId","relation_key":"relationKey","relation_name":"relationName","source_types":"sourceTypes","target_types":"targetTypes","default_target_type":"defaultTargetType","created_at":"createdAt"}),
    types: Object.freeze({"entryId":{"type":"TEXT","nullable":false},"relationKey":{"type":"TEXT","nullable":false},"relationName":{"type":"TEXT","nullable":false},"sourceTypes":{"type":"TEXT","nullable":false},"targetTypes":{"type":"TEXT","nullable":false},"defaultTargetType":{"type":"TEXT","nullable":false},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["entryId"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'recognitionPatterns', table: 'regex_user_patterns',
    fields: Object.freeze({"pattern_id":"patternId","pattern_text":"patternText","score":"score","category":"category","polarity":"polarity","description":"description","lang":"lang","enabled":"enabled","match_count":"matchCount","created_at":"createdAt","updated_at":"updatedAt"}),
    types: Object.freeze({"patternId":{"type":"TEXT","nullable":false},"patternText":{"type":"TEXT","nullable":false},"score":{"type":"INTEGER","nullable":false},"category":{"type":"TEXT","nullable":false},"polarity":{"type":"TEXT","nullable":true},"description":{"type":"TEXT","nullable":true},"lang":{"type":"TEXT","nullable":false},"enabled":{"type":"INTEGER","nullable":false},"matchCount":{"type":"INTEGER","nullable":false},"createdAt":{"type":"TEXT","nullable":false},"updatedAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["patternId"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'recognitionBoosters', table: 'regex_user_boosters',
    fields: Object.freeze({"booster_id":"boosterId","word":"word","score":"score","description":"description","lang":"lang","enabled":"enabled","hit_count":"hitCount","created_at":"createdAt","updated_at":"updatedAt"}),
    types: Object.freeze({"boosterId":{"type":"TEXT","nullable":false},"word":{"type":"TEXT","nullable":false},"score":{"type":"INTEGER","nullable":false},"description":{"type":"TEXT","nullable":true},"lang":{"type":"TEXT","nullable":false},"enabled":{"type":"INTEGER","nullable":false},"hitCount":{"type":"INTEGER","nullable":false},"createdAt":{"type":"TEXT","nullable":false},"updatedAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["boosterId"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'assets', table: 'asset_files',
    fields: Object.freeze({"sha256":"sha256","asset_type":"assetType","asset_path":"assetPath","byte_size":"byteSize","mime_type":"mimeType","original_name":"originalName","first_imported_at":"firstImportedAt"}),
    types: Object.freeze({"sha256":{"type":"TEXT","nullable":false},"assetType":{"type":"TEXT","nullable":false},"assetPath":{"type":"TEXT","nullable":false},"byteSize":{"type":"INTEGER","nullable":false},"mimeType":{"type":"TEXT","nullable":true},"originalName":{"type":"TEXT","nullable":true},"firstImportedAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["sha256"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'assetImports', table: 'asset_file_imports',
    fields: Object.freeze({"import_id":"importId","asset_sha256":"assetSha256","source":"source","source_ref":"sourceRef","original_name":"originalName","imported_at":"importedAt","author":"author","user_id":"userId"}),
    types: Object.freeze({"importId":{"type":"TEXT","nullable":false},"assetSha256":{"type":"TEXT","nullable":false},"source":{"type":"TEXT","nullable":false},"sourceRef":{"type":"TEXT","nullable":true},"originalName":{"type":"TEXT","nullable":true},"importedAt":{"type":"TEXT","nullable":false},"author":{"type":"TEXT","nullable":false},"userId":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["importId"]),
    references: Object.freeze([{"field":"assetSha256","collection":"assets","targetField":"sha256"}]) }),
  Object.freeze({ name: 'documents', table: 'documents',
    fields: Object.freeze({"document_id":"documentId","asset_sha256":"assetSha256","title":"title","document_type":"documentType","chunk_count":"chunkCount","has_summary":"hasSummary","has_extracted":"hasExtracted","source_metadata":"sourceMetadata","created_at":"createdAt","updated_at":"updatedAt"}),
    types: Object.freeze({"documentId":{"type":"TEXT","nullable":false},"assetSha256":{"type":"TEXT","nullable":false},"title":{"type":"TEXT","nullable":false},"documentType":{"type":"TEXT","nullable":false},"chunkCount":{"type":"INTEGER","nullable":false},"hasSummary":{"type":"INTEGER","nullable":false},"hasExtracted":{"type":"INTEGER","nullable":false},"sourceMetadata":{"type":"TEXT","nullable":false},"createdAt":{"type":"TEXT","nullable":false},"updatedAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["documentId"]),
    references: Object.freeze([{"field":"assetSha256","collection":"assets","targetField":"sha256"}]) }),
  Object.freeze({ name: 'documentOwners', table: 'document_record_owners',
    fields: Object.freeze({"document_id":"documentId","node_id":"nodeId","created_at":"createdAt"}),
    types: Object.freeze({"documentId":{"type":"TEXT","nullable":false},"nodeId":{"type":"INTEGER","nullable":false},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["documentId"]),
    references: Object.freeze([{"field":"documentId","collection":"documents","targetField":"documentId"}]) }),
  Object.freeze({ name: 'images', table: 'images',
    fields: Object.freeze({"asset_sha256":"assetSha256","thumb_sha256":"thumbSha256","width":"width","height":"height","mime":"mime","preserve_mode":"preserveMode","is_animated":"isAnimated","warnings_json":"warningsJson","has_caption_auto":"hasCaptionAuto","created_at":"createdAt"}),
    types: Object.freeze({"assetSha256":{"type":"TEXT","nullable":false},"thumbSha256":{"type":"TEXT","nullable":true},"width":{"type":"INTEGER","nullable":false},"height":{"type":"INTEGER","nullable":false},"mime":{"type":"TEXT","nullable":false},"preserveMode":{"type":"TEXT","nullable":false},"isAnimated":{"type":"INTEGER","nullable":false},"warningsJson":{"type":"TEXT","nullable":false},"hasCaptionAuto":{"type":"INTEGER","nullable":false},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["assetSha256"]),
    references: Object.freeze([{"field":"assetSha256","collection":"assets","targetField":"sha256"}]) }),
  Object.freeze({ name: 'chunkSummaries', table: 'chunk_summaries',
    fields: Object.freeze({"summary_id":"summaryId","parent_chunk_id":"parentChunkId","parent_document_id":"parentDocumentId","summary_text":"summaryText","generated_by":"generatedBy","generated_at":"generatedAt","has_embedding":"hasEmbedding"}),
    types: Object.freeze({"summaryId":{"type":"TEXT","nullable":false},"parentChunkId":{"type":"INTEGER","nullable":false},"parentDocumentId":{"type":"TEXT","nullable":false},"summaryText":{"type":"TEXT","nullable":false},"generatedBy":{"type":"TEXT","nullable":false},"generatedAt":{"type":"TEXT","nullable":false},"hasEmbedding":{"type":"INTEGER","nullable":false}}),
    primaryKey: Object.freeze(["summaryId"]),
    references: Object.freeze([{"field":"parentDocumentId","collection":"documents","targetField":"documentId"},{"field":"parentChunkId","collection":"memories","targetField":"id"}]) }),
  Object.freeze({ name: 'relationSummaries', table: 'relation_summaries',
    fields: Object.freeze({"summary_id":"summaryId","from_concept_id":"fromConceptId","to_concept_id":"toConceptId","relation_name":"relationName","summary_text":"summaryText","confidence":"confidence","generated_by":"generatedBy","generated_at":"generatedAt","has_embedding":"hasEmbedding","source_document_id":"sourceDocumentId"}),
    types: Object.freeze({"summaryId":{"type":"TEXT","nullable":false},"fromConceptId":{"type":"TEXT","nullable":false},"toConceptId":{"type":"TEXT","nullable":false},"relationName":{"type":"TEXT","nullable":false},"summaryText":{"type":"TEXT","nullable":false},"confidence":{"type":"REAL","nullable":false},"generatedBy":{"type":"TEXT","nullable":false},"generatedAt":{"type":"TEXT","nullable":false},"hasEmbedding":{"type":"INTEGER","nullable":false},"sourceDocumentId":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["summaryId"]),
    references: Object.freeze([{"field":"sourceDocumentId","collection":"documents","targetField":"documentId"}]) }),
  Object.freeze({ name: 'aliasSuggestions', table: 'concept_alias_suggestions',
    fields: Object.freeze({"suggestion_id":"suggestionId","new_concept_id":"newConceptId","candidate_concept_id":"candidateConceptId","cosine":"cosine","status":"status","created_at":"createdAt","resolved_at":"resolvedAt"}),
    types: Object.freeze({"suggestionId":{"type":"TEXT","nullable":false},"newConceptId":{"type":"TEXT","nullable":false},"candidateConceptId":{"type":"TEXT","nullable":false},"cosine":{"type":"REAL","nullable":false},"status":{"type":"TEXT","nullable":false},"createdAt":{"type":"TEXT","nullable":false},"resolvedAt":{"type":"TEXT","nullable":true}}),
    primaryKey: Object.freeze(["suggestionId"]),
    references: Object.freeze([{"field":"candidateConceptId","collection":"concepts","targetField":"conceptId"},{"field":"newConceptId","collection":"concepts","targetField":"conceptId"}]) }),
  Object.freeze({ name: 'cleanupProposals', table: 'cleanup_proposals',
    fields: Object.freeze({"id":"id","kind":"kind","payload_json":"payloadJson","status":"status","created_at":"createdAt","resolved_at":"resolvedAt"}),
    types: Object.freeze({"id":{"type":"TEXT","nullable":false},"kind":{"type":"TEXT","nullable":false},"payloadJson":{"type":"TEXT","nullable":false},"status":{"type":"TEXT","nullable":false},"createdAt":{"type":"TEXT","nullable":false},"resolvedAt":{"type":"TEXT","nullable":true}}),
    primaryKey: Object.freeze(["id"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'cleanupItems', table: 'cleanup_proposal_item_journal',
    fields: Object.freeze({"proposal_id":"proposalId","item_key":"itemKey","status":"status","detail":"detail","after_fingerprint":"afterFingerprint","applied_at":"appliedAt"}),
    types: Object.freeze({"proposalId":{"type":"TEXT","nullable":false},"itemKey":{"type":"TEXT","nullable":false},"status":{"type":"TEXT","nullable":false},"detail":{"type":"TEXT","nullable":true},"afterFingerprint":{"type":"TEXT","nullable":true},"appliedAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["proposalId","itemKey"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'cleanupStages', table: 'cleanup_stage_results',
    fields: Object.freeze({"stage":"stage","target_key":"targetKey","status":"status","input_fingerprint":"inputFingerprint","stage_version":"stageVersion","attempt_count":"attemptCount","next_retry_at":"nextRetryAt","last_error":"lastError","updated_at":"updatedAt"}),
    types: Object.freeze({"stage":{"type":"TEXT","nullable":false},"targetKey":{"type":"TEXT","nullable":false},"status":{"type":"TEXT","nullable":false},"inputFingerprint":{"type":"TEXT","nullable":false},"stageVersion":{"type":"INTEGER","nullable":false},"attemptCount":{"type":"INTEGER","nullable":false},"nextRetryAt":{"type":"TEXT","nullable":true},"lastError":{"type":"TEXT","nullable":true},"updatedAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["stage","targetKey"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'cleanupRuns', table: 'cleanup_runs',
    fields: Object.freeze({"run_id":"runId","trigger":"trigger","status":"status","started_at":"startedAt","finished_at":"finishedAt","options_json":"optionsJson","aggregates_json":"aggregatesJson","idempotency_key":"idempotencyKey"}),
    types: Object.freeze({"runId":{"type":"TEXT","nullable":false},"trigger":{"type":"TEXT","nullable":false},"status":{"type":"TEXT","nullable":false},"startedAt":{"type":"TEXT","nullable":false},"finishedAt":{"type":"TEXT","nullable":true},"optionsJson":{"type":"TEXT","nullable":false},"aggregatesJson":{"type":"TEXT","nullable":false},"idempotencyKey":{"type":"TEXT","nullable":true}}),
    primaryKey: Object.freeze(["runId"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'events', table: 'events',
    fields: Object.freeze({"id":"id","type":"type","payload_json":"payloadJson","created_at":"createdAt"}),
    types: Object.freeze({"id":{"type":"INTEGER","nullable":false},"type":{"type":"TEXT","nullable":false},"payloadJson":{"type":"TEXT","nullable":false},"createdAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["id"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'evolutionHistory', table: 'evolver_activity',
    fields: Object.freeze({"id":"id","ran_at":"ranAt","cluster_edges_added":"clusterEdgesAdded","nodes_archived":"nodesArchived","nodes_purged":"nodesPurged","soon_to_purge_count":"soonToPurgeCount"}),
    types: Object.freeze({"id":{"type":"INTEGER","nullable":false},"ranAt":{"type":"TEXT","nullable":false},"clusterEdgesAdded":{"type":"INTEGER","nullable":false},"nodesArchived":{"type":"INTEGER","nullable":false},"nodesPurged":{"type":"INTEGER","nullable":false},"soonToPurgeCount":{"type":"INTEGER","nullable":false}}),
    primaryKey: Object.freeze(["id"]),
    references: Object.freeze([]) }),
  Object.freeze({ name: 'tagReflows', table: 'tag_reflow_log',
    fields: Object.freeze({"log_id":"logId","node_id":"nodeId","parent_concept_id":"parentConceptId","trigger_hierarchy":"triggerHierarchy","detached_at":"detachedAt"}),
    types: Object.freeze({"logId":{"type":"TEXT","nullable":false},"nodeId":{"type":"INTEGER","nullable":false},"parentConceptId":{"type":"TEXT","nullable":false},"triggerHierarchy":{"type":"TEXT","nullable":false},"detachedAt":{"type":"TEXT","nullable":false}}),
    primaryKey: Object.freeze(["logId"]),
    references: Object.freeze([]) }),
]);
for (const descriptor of COLLECTIONS) {
  for (const spec of Object.values(descriptor.types)) Object.freeze(spec);
  for (const reference of descriptor.references) Object.freeze(reference);
}
export const COLLECTION_BY_NAME = Object.freeze(Object.fromEntries(COLLECTIONS.map(d => [d.name, d])) as Record<string, CollectionDescriptor>);
export const ALLOCATORS = Object.freeze({ memories: 'knowledge_nodes', memoryEdges: 'knowledge_edges', revisions: 'memory_revisions', events: 'events', evolutionHistory: 'evolver_activity' });
export const INDEX_TABLES = Object.freeze(['vec_nodes','concept_vec','person_vec','entities_vec','chunk_summary_vec','relation_summary_vec','concept_siglip_vec','image_vec','knowledge_nodes_fts','knowledge_nodes_trgm','concept_nodes_fts','concept_nodes_uni','persons_fts','persons_uni','entities_fts','entities_uni']);
/** 이 포터블 형식(v1)이 읽을 수 있는 원본 스키마 버전 — 기준 47 과 그 뒤 마이그레이션. 펫은 업데이트 직전에
 * 새 프로그램으로 옛 DB 를 내보내므로 바로 이전 배포의 버전도 받아야 한다(아래 assertSourceSchema 주석). */
export const SUPPORTED_SOURCE_SCHEMA_VERSIONS: readonly number[] = Object.freeze([47, 48, 49]);

/** 포터블 형식 v1 이 담지 않는 표. since 는 그 표가 생긴 스키마 버전이다. */
export interface ExcludedTable { columns: readonly string[]; since: number; reason: string }

export const EXCLUDED_TABLE_SPECS: Readonly<Record<string, ExcludedTable>> = Object.freeze({
  schema_version: { columns: Object.freeze(['version', 'applied_at']), since: 47, reason: 'Target schema version is created by the restorer' },
  memory_visibility_state: { columns: Object.freeze(['id', 'generation']), since: 47, reason: 'Target visibility generation is recomputed' },
  asset_folder_pairing: { columns: Object.freeze(['id', 'pairing_id', 'created_at']), since: 47, reason: 'Target asset folder receives a new pairing identity' },
  entity_register_records: {
    columns: Object.freeze(['id', 'stage', 'run_id', 'proposal_id', 'source_node_id', 'item_kind', 'target_type', 'target_id', 'name', 'decided_by', 'status', 'detail_json', 'created_at', 'reverted_at']),
    since: 48, reason: 'Auto-registration undo records are not part of portable format v1',
  },
  entity_register_ignores: {
    columns: Object.freeze(['source_node_id', 'kind', 'name_key', 'reason', 'created_at']),
    since: 48, reason: 'Auto-registration ignore records are not part of portable format v1',
  },
  document_ocr_page_results: {
    columns: Object.freeze(['document_id', 'page_index', 'page_count', 'input_fingerprint', 'status', 'markdown', 'attempt_count', 'next_retry_at', 'last_error', 'input_tokens', 'output_tokens', 'updated_at']),
    since: 49, reason: 'Server OCR page work ledger is transient processing state, not part of portable format v1',
  },
  document_ocr_daily_usage: {
    columns: Object.freeze(['day', 'page_calls']),
    since: 49, reason: 'Server OCR daily call counter is transient processing state, not part of portable format v1',
  },
});

export function excludedTablesFor(schemaVersion: number): Record<string, readonly string[]> {
  return Object.fromEntries(
    Object.entries(EXCLUDED_TABLE_SPECS).filter(([, spec]) => spec.since <= schemaVersion).map(([name, spec]) => [name, spec.columns]),
  );
}

export function exclusionEntriesFor(schemaVersion: number): Array<{ name: string; reason: string }> {
  return Object.entries(EXCLUDED_TABLE_SPECS).filter(([, spec]) => spec.since <= schemaVersion).map(([name, spec]) => ({ name, reason: spec.reason }));
}

/** Fail closed on source tables and columns unknown to this frozen mapping.
 *
 * 스키마를 바꿀 때 지킬 것: 바라 펫은 업데이트 직전에 *새* 프로그램의 내보내기로 *옛* DB 를 읽는다(apps/pet
 * `src/service/maintenance/upgrade.ts`, 마이그레이션 전). 그래서 새 스키마(v48+)를 도입해도 이 함수와 매핑은 바로
 * 이전 배포의 스키마를 계속 읽을 수 있어야 한다 — 이전 버전을 거절하면 모든 업데이트가 백업 단계에서 멈춘다. */
export function assertSourceSchema(db: Database): number {
  const version = db.query('SELECT MAX(version) AS version FROM schema_version').get() as {
    version: number;
  };
  const sourceVersion = Number(version.version);
  if (!SUPPORTED_SOURCE_SCHEMA_VERSIONS.includes(sourceVersion))
    throw new Error('Unsupported source schema version');
  const tables = db.query('PRAGMA table_list').all() as Array<{
    name: string;
    type: string;
    schema: string;
  }>;
  const ordinary = tables.filter(t => t.schema === 'main' && t.type === 'table' && !t.name.startsWith('sqlite_') && !INDEX_TABLES.slice(0, 8).some(n => t.name === n + '_vector_chunks00'));
  const expected = new Map<string, readonly string[]>([...COLLECTIONS.map(d => [d.table, Object.keys(d.fields)] as const), ...Object.entries(excludedTablesFor(sourceVersion))]);
  for (const table of ordinary) {
    const columns = expected.get(table.name);
    if (!columns)
      throw new Error('Unclassified source table: ' + table.name);
    const statement=db.prepare('PRAGMA table_info("' + table.name + '")');
    let info:Array<{
      name: string;
      type: string;
      notnull: number | bigint;
      pk: number | bigint;
    }>;
    try{info=statement.all() as typeof info;}finally{statement.finalize();}
    const actual = info.map(c => c.name);
    const descriptor = COLLECTIONS.find(d => d.table === table.name);
    if (descriptor && info.some(c => { const spec = descriptor.types[descriptor.fields[c.name]!]; return !spec || spec.type !== c.type || spec.nullable !== (!Number(c.notnull) && !Number(c.pk)); }))
      throw new Error('Unsupported source field shape: ' + table.name);
    if (actual.length !== columns.length || actual.some(c => !columns.includes(c)))
      throw new Error('Unsupported source columns: ' + table.name);
    expected.delete(table.name);
  }
  if (expected.size)
    throw new Error('Missing source tables: ' + [...expected.keys()].join(', '));
  const virtual = tables.filter(t => t.schema === 'main' && t.type === 'virtual');
  if (virtual.some(t => !INDEX_TABLES.includes(t.name)) || INDEX_TABLES.some(n => !virtual.some(t => t.name === n)))
    throw new Error('Unsupported source indexes');
  return sourceVersion;
}
/** Integer columns are read as decimal TEXT; source TEXT is decoded strictly from its bytes. */
export function readPortableCollections(db: Database): Record<string, PortableRecord[]> {
  const collections: Record<string, PortableRecord[]> = {};
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const descriptor of COLLECTIONS) {
    const select = Object.entries(descriptor.fields).map(([column, field]) => {
      const type = descriptor.types[field]!.type;
      const expression = type === 'INTEGER' ? 'CAST("' + column + '" AS TEXT)' : type === 'TEXT' ? 'CAST("' + column + '" AS BLOB)' : '"' + column + '"';
      return expression + ' AS "' + column + '", typeof("' + column + '") AS "__storage_' + column + '"';
    }).join(',');
    // Forty-one scans exceed Bun's cache; finalize before vec/FTS checks and strict close.
    const statement = db.prepare('SELECT ' + select + ' FROM "' + descriptor.table + '"');
    let rows:Array<Record<string,unknown>>;
    try { rows=statement.all() as Array<Record<string,unknown>>; } finally { statement.finalize(); }
    collections[descriptor.name] = rows.map(row => {
      const record: PortableRecord = {};
      for (const [column, field] of Object.entries(descriptor.fields)) {
        let value = row[column];
        const context = descriptor.name + '.' + field;
        if (value !== null) {
          const storageType = row['__storage_' + column];
          const declaredType = descriptor.types[field]!.type;
          if ((declaredType === 'TEXT' && storageType !== 'text') || (declaredType === 'INTEGER' && storageType !== 'integer') || (declaredType === 'REAL' && storageType !== 'real' && storageType !== 'integer')) {
            throw new Error('Invalid source storage type: ' + context);
          }
          try {
            if (descriptor.types[field]!.type === 'INTEGER') value = BigInt(value as string);
            if (descriptor.types[field]!.type === 'TEXT') value = decoder.decode(value as Uint8Array);
          } catch (error) {
            throw new Error('Invalid source scalar: ' + context, { cause: error });
          }
        }
        record[field] = assertPortableScalar(value, context);
      }
      return record;
    });
  }
  return collections;
}
