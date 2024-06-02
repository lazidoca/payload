import type { JSONSchema4 } from 'json-schema'
import type {
  EditorConfig as LexicalEditorConfig,
  SerializedEditorState,
  SerializedLexicalNode,
} from 'lexical'

import { withMergedProps } from '@payloadcms/ui/elements/withMergedProps'
import { withNullableJSONSchemaType } from 'payload/utilities'

import type { FeatureProviderServer, ResolvedServerFeatureMap } from './field/features/types.js'
import type { SanitizedServerEditorConfig } from './field/lexical/config/types.js'
import type {
  AdapterProps,
  LexicalEditorProps,
  LexicalRichTextAdapter,
  LexicalRichTextAdapterProvider,
} from './types.js'

import { RichTextCell } from './cell/index.js'
import { RichTextField } from './field/index.js'
import {
  defaultEditorConfig,
  defaultEditorFeatures,
} from './field/lexical/config/server/default.js'
import { loadFeatures } from './field/lexical/config/server/loader.js'
import {
  sanitizeServerEditorConfig,
  sanitizeServerFeatures,
} from './field/lexical/config/server/sanitize.js'
import { cloneDeep } from './field/lexical/utils/cloneDeep.js'
import { getGenerateComponentMap } from './generateComponentMap.js'
import { getGenerateSchemaMap } from './generateSchemaMap.js'
import { i18n } from './i18n.js'
import { populateLexicalPopulationPromises } from './populateGraphQL/populateLexicalPopulationPromises.js'
import { recurseNodeTree } from './recurseNodeTree.js'
import { richTextValidateHOC } from './validate/index.js'

let defaultSanitizedServerEditorConfig: SanitizedServerEditorConfig = null

export function lexicalEditor(props?: LexicalEditorProps): LexicalRichTextAdapterProvider {
  return async ({ config, isRoot }) => {
    let features: FeatureProviderServer<unknown, unknown>[] = []
    let resolvedFeatureMap: ResolvedServerFeatureMap

    let finalSanitizedEditorConfig: SanitizedServerEditorConfig // For server only
    if (!props || (!props.features && !props.lexical)) {
      if (!defaultSanitizedServerEditorConfig) {
        defaultSanitizedServerEditorConfig = await sanitizeServerEditorConfig(
          defaultEditorConfig,
          config,
        )
        features = cloneDeep(defaultEditorFeatures)
      }

      finalSanitizedEditorConfig = cloneDeep(defaultSanitizedServerEditorConfig)

      resolvedFeatureMap = finalSanitizedEditorConfig.resolvedFeatureMap
    } else {
      const rootEditor = config.editor
      let rootEditorFeatures: FeatureProviderServer<unknown, unknown>[] = []
      if (typeof rootEditor === 'object' && 'features' in rootEditor) {
        rootEditorFeatures = (rootEditor as LexicalRichTextAdapter).features
      }

      features =
        props.features && typeof props.features === 'function'
          ? props.features({
              defaultFeatures: cloneDeep(defaultEditorFeatures),
              rootFeatures: rootEditorFeatures,
            })
          : (props.features as FeatureProviderServer<unknown, unknown>[])
      if (!features) {
        features = cloneDeep(defaultEditorFeatures)
      }

      const lexical: LexicalEditorConfig = props.lexical

      resolvedFeatureMap = await loadFeatures({
        config,
        isRoot,
        unSanitizedEditorConfig: {
          features,
          lexical: lexical ? lexical : defaultEditorConfig.lexical,
        },
      })

      finalSanitizedEditorConfig = {
        features: sanitizeServerFeatures(resolvedFeatureMap),
        lexical: lexical ? lexical : defaultEditorConfig.lexical,
        resolvedFeatureMap,
      }
    }

    const featureI18n = finalSanitizedEditorConfig.features.i18n
    for (const lang in i18n) {
      if (!featureI18n[lang]) {
        featureI18n[lang] = {
          lexical: {},
        }
      }

      featureI18n[lang].lexical.general = i18n[lang]
    }

    return {
      CellComponent: withMergedProps({
        Component: RichTextCell,
        toMergeIntoProps: {
          admin: props?.admin,
          lexicalEditorConfig: finalSanitizedEditorConfig.lexical,
        },
      }),
      FieldComponent: withMergedProps({
        Component: RichTextField,
        toMergeIntoProps: {
          admin: props?.admin,
          lexicalEditorConfig: finalSanitizedEditorConfig.lexical,
        },
      }),
      editorConfig: finalSanitizedEditorConfig,
      features,
      generateComponentMap: getGenerateComponentMap({
        resolvedFeatureMap,
      }),
      generateSchemaMap: getGenerateSchemaMap({
        resolvedFeatureMap,
      }),
      graphQLPopulationPromises({
        context,
        currentDepth,
        depth,
        draft,
        field,
        fieldPromises,
        findMany,
        flattenLocales,
        overrideAccess,
        populationPromises,
        req,
        showHiddenFields,
        siblingDoc,
      }) {
        // check if there are any features with nodes which have populationPromises for this field
        if (finalSanitizedEditorConfig?.features?.graphQLPopulationPromises?.size) {
          populateLexicalPopulationPromises({
            context,
            currentDepth: currentDepth ?? 0,
            depth,
            draft,
            editorPopulationPromises: finalSanitizedEditorConfig.features.graphQLPopulationPromises,
            field,
            fieldPromises,
            findMany,
            flattenLocales,
            overrideAccess,
            populationPromises,
            req,
            showHiddenFields,
            siblingDoc,
          })
        }
      },
      hooks: {
        afterChange: [
          async ({ context: _context, operation, path, req, schemaPath, value }) => {
            if (!finalSanitizedEditorConfig.features.hooks.afterChange.size) {
              return value
            }
            const context: any = _context
            const nodeIDMap: {
              [key: string]: SerializedLexicalNode
            } = {}

            /**
             * Get the originalNodeIDMap from the beforeValidate hook, which is always run before this hook.
             */
            const originalNodeIDMap: {
              [key: string]: SerializedLexicalNode
            } = context?.internal?.lexical?.[path.join('.')]?.originalNodeIDMap

            if (!originalNodeIDMap || !Object.keys(originalNodeIDMap).length || !value) {
              return value
            }

            recurseNodeTree({
              nodeIDMap,
              nodes: (value as SerializedEditorState)?.root?.children ?? [],
            })

            // eslint-disable-next-line prefer-const
            for (let [id, node] of Object.entries(nodeIDMap)) {
              const afterChangeHooks = finalSanitizedEditorConfig.features.hooks.afterChange
              if (afterChangeHooks?.has(node.type)) {
                for (const hook of afterChangeHooks.get(node.type)) {
                  node = await hook({
                    context,
                    node,
                    operation,
                    originalNode: originalNodeIDMap[id],
                    parentRichTextFieldPath: path,
                    parentRichTextFieldSchemaPath: schemaPath,
                    req,
                  })
                }
              }
            }

            return value
          },
        ],
        afterRead: [
          /**
           * afterRead hooks do not receive the originalNode. Thus, they can run on all nodes, not just nodes with an ID.
           */
          async ({
            context: context,
            currentDepth,
            depth,
            draft,
            fallbackLocale,
            fieldPromises,
            findMany,
            flattenLocales,
            locale,
            overrideAccess,
            path,
            populationPromises,
            req,
            schemaPath,
            showHiddenFields,
            triggerAccessControl,
            triggerHooks,
            value,
          }) => {
            if (!finalSanitizedEditorConfig.features.hooks.afterRead.size) {
              return value
            }
            const flattenedNodes: SerializedLexicalNode[] = []

            recurseNodeTree({
              flattenedNodes,
              nodes: (value as SerializedEditorState)?.root?.children ?? [],
            })

            for (let node of flattenedNodes) {
              const afterReadHooks = finalSanitizedEditorConfig.features.hooks.afterRead
              if (afterReadHooks?.has(node.type)) {
                for (const hook of afterReadHooks.get(node.type)) {
                  node = await hook({
                    context,
                    currentDepth,
                    depth,
                    draft,
                    fallbackLocale,
                    fieldPromises,
                    findMany,
                    flattenLocales,
                    locale,
                    node,
                    overrideAccess,
                    parentRichTextFieldPath: path,
                    parentRichTextFieldSchemaPath: schemaPath,
                    populationPromises,
                    req,
                    showHiddenFields,
                    triggerAccessControl,
                    triggerHooks,
                  })
                }
              }
            }

            return value
          },
        ],
        beforeChange: [
          async ({
            context: _context,
            duplicate,
            errors,
            field,
            mergeLocaleActions,
            operation,
            path,
            req,
            schemaPath,
            siblingDocWithLocales,
            skipValidation,
            value,
          }) => {
            if (!finalSanitizedEditorConfig.features.hooks.beforeChange.size) {
              return value
            }

            const context: any = _context
            const nodeIDMap: {
              [key: string]: SerializedLexicalNode
            } = {}

            /**
             * Get the originalNodeIDMap from the beforeValidate hook, which is always run before this hook.
             */
            const originalNodeIDMap: {
              [key: string]: SerializedLexicalNode
            } = context?.internal?.lexical?.[path.join('.')]?.originalNodeIDMap

            if (!originalNodeIDMap || !Object.keys(originalNodeIDMap).length || !value) {
              return value
            }

            const originalNodeWithLocalesIDMap: {
              [key: string]: SerializedLexicalNode
            } = {}

            recurseNodeTree({
              nodeIDMap,
              nodes: (value as SerializedEditorState)?.root?.children ?? [],
            })

            if (siblingDocWithLocales?.[field.name]) {
              recurseNodeTree({
                nodeIDMap: originalNodeWithLocalesIDMap,
                nodes:
                  (siblingDocWithLocales[field.name] as SerializedEditorState)?.root?.children ??
                  [],
              })
            }

            // eslint-disable-next-line prefer-const
            for (let [id, node] of Object.entries(nodeIDMap)) {
              const beforeChangeHooks = finalSanitizedEditorConfig.features.hooks.beforeChange
              if (beforeChangeHooks?.has(node.type)) {
                for (const hook of beforeChangeHooks.get(node.type)) {
                  node = await hook({
                    context,
                    duplicate,
                    errors,
                    mergeLocaleActions,
                    node,
                    operation,
                    originalNode: originalNodeIDMap[id],
                    originalNodeWithLocales: originalNodeWithLocalesIDMap[id],
                    parentRichTextFieldPath: path,
                    parentRichTextFieldSchemaPath: schemaPath,
                    req,
                    skipValidation,
                  })
                }
              }
            }

            return value
          },
        ],
        beforeDuplicate: [
          async ({ context: _context, path, req, schemaPath, value }) => {
            if (!finalSanitizedEditorConfig.features.hooks.beforeDuplicate.size) {
              return value
            }
            const context: any = _context
            const nodeIDMap: {
              [key: string]: SerializedLexicalNode
            } = {}

            /**
             * Get the originalNodeIDMap from the beforeValidate hook, which is always run before this hook.
             */
            const originalNodeIDMap: {
              [key: string]: SerializedLexicalNode
            } = context?.internal?.lexical?.[path.join('.')]?.originalNodeIDMap

            if (!originalNodeIDMap || !Object.keys(originalNodeIDMap).length || !value) {
              return value
            }

            recurseNodeTree({
              nodeIDMap,
              nodes: (value as SerializedEditorState)?.root?.children ?? [],
            })

            // eslint-disable-next-line prefer-const
            for (let [id, node] of Object.entries(nodeIDMap)) {
              const beforeDuplicateHooks = finalSanitizedEditorConfig.features.hooks.beforeDuplicate
              if (beforeDuplicateHooks?.has(node.type)) {
                for (const hook of beforeDuplicateHooks.get(node.type)) {
                  node = await hook({
                    context,
                    node,
                    originalNode: originalNodeIDMap[id],
                    parentRichTextFieldPath: path,
                    parentRichTextFieldSchemaPath: schemaPath,
                    req,
                  })
                }
              }
            }

            return value
          },
        ],
        beforeValidate: [
          async ({
            context,
            operation,
            overrideAccess,
            path,
            previousValue,
            req,
            schemaPath,
            value,
          }) => {
            // return value if there are NO hooks
            if (
              !finalSanitizedEditorConfig.features.hooks.beforeValidate.size &&
              !finalSanitizedEditorConfig.features.hooks.afterChange.size &&
              !finalSanitizedEditorConfig.features.hooks.beforeChange.size &&
              !finalSanitizedEditorConfig.features.hooks.beforeDuplicate.size
            ) {
              return value
            }

            /**
             * beforeValidate is the first field hook which runs. This is where we can create the node map, which can then be used in the other hooks.
             *
             */

            /**
             * flattenedNodes contains all nodes in the editor, in the order they appear in the editor. They will be used for the following hooks:
             * - afterRead
             *
             * The other hooks require nodes to have IDs, which is why those are ran only from the nodeIDMap. They require IDs because they have both doc/siblingDoc and data/siblingData, and
             * thus require a reliable way to match new node data to old node data. Given that node positions can change in between hooks, this is only reliably possible for nodes which are saved with
             * an ID.
             */
            //const flattenedNodes: SerializedLexicalNode[] = []

            /**
             * Only nodes with id's (so, nodes with hooks added to them) will be added to the nodeIDMap. They will be used for the following hooks:
             * - afterChange
             * - beforeChange
             * - beforeValidate
             * - beforeDuplicate
             *
             * Other hooks are handled by the flattenedNodes. All nodes in the nodeIDMap are part of flattenedNodes.
             */

            const originalNodeIDMap: {
              [key: string]: SerializedLexicalNode
            } = {}

            recurseNodeTree({
              nodeIDMap: originalNodeIDMap,
              nodes: (previousValue as SerializedEditorState)?.root?.children ?? [],
            })

            // Add to context, for other hooks to use
            if (!context.internal) {
              context.internal = {}
            }
            if (!(context as any).internal.lexical) {
              ;(context as any).internal.lexical = {}
            }
            ;(context as any).internal.lexical[path.join('.')] = {
              originalNodeIDMap,
            }

            /**
             * Now that the maps for all hooks are set up, we can run the validate hook
             */
            if (!finalSanitizedEditorConfig.features.hooks.beforeValidate.size) {
              return value
            }
            const nodeIDMap: {
              [key: string]: SerializedLexicalNode
            } = {}
            recurseNodeTree({
              //flattenedNodes,
              nodeIDMap,
              nodes: (value as SerializedEditorState)?.root?.children ?? [],
            })

            // eslint-disable-next-line prefer-const
            for (let [id, node] of Object.entries(nodeIDMap)) {
              const beforeValidateHooks = finalSanitizedEditorConfig.features.hooks.beforeValidate
              if (beforeValidateHooks?.has(node.type)) {
                for (const hook of beforeValidateHooks.get(node.type)) {
                  node = await hook({
                    context,
                    node,
                    operation,
                    originalNode: originalNodeIDMap[id],
                    overrideAccess,
                    parentRichTextFieldPath: path,
                    parentRichTextFieldSchemaPath: schemaPath,
                    req,
                  })
                }
              }
            }

            return value
          },
        ],
      },
      i18n: featureI18n,
      outputSchema: ({
        collectionIDFieldTypes,
        config,
        field,
        interfaceNameDefinitions,
        isRequired,
      }) => {
        let outputSchema: JSONSchema4 = {
          // This schema matches the SerializedEditorState type so far, that it's possible to cast SerializedEditorState to this schema without any errors.
          // In the future, we should
          // 1) allow recursive children
          // 2) Pass in all the different types for every node added to the editorconfig. This can be done with refs in the schema.
          type: withNullableJSONSchemaType('object', isRequired),
          properties: {
            root: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: {
                  type: 'string',
                },
                children: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                      type: {
                        type: 'string',
                      },
                      version: {
                        type: 'integer',
                      },
                    },
                    required: ['type', 'version'],
                  },
                },
                direction: {
                  oneOf: [
                    {
                      enum: ['ltr', 'rtl'],
                    },
                    {
                      type: 'null',
                    },
                  ],
                },
                format: {
                  type: 'string',
                  enum: ['left', 'start', 'center', 'right', 'end', 'justify', ''], // ElementFormatType, since the root node is an element
                },
                indent: {
                  type: 'integer',
                },
                version: {
                  type: 'integer',
                },
              },
              required: ['children', 'direction', 'format', 'indent', 'type', 'version'],
            },
          },
          required: ['root'],
        }
        for (const modifyOutputSchema of finalSanitizedEditorConfig.features.generatedTypes
          .modifyOutputSchemas) {
          outputSchema = modifyOutputSchema({
            collectionIDFieldTypes,
            config,
            currentSchema: outputSchema,
            field,
            interfaceNameDefinitions,
            isRequired,
          })
        }

        return outputSchema
      },
      validate: richTextValidateHOC({
        editorConfig: finalSanitizedEditorConfig,
      }),
    }
  }
}

export { AlignFeature } from './field/features/align/feature.server.js'
export { BlockquoteFeature } from './field/features/blockquote/feature.server.js'
export { BlocksFeature, type BlocksFeatureProps } from './field/features/blocks/feature.server.js'
export {
  $createBlockNode,
  $isBlockNode,
  type BlockFields,
  BlockNode,
  type SerializedBlockNode,
} from './field/features/blocks/nodes/BlocksNode.js'

export { LinebreakHTMLConverter } from './field/features/converters/html/converter/converters/linebreak.js'
export { ParagraphHTMLConverter } from './field/features/converters/html/converter/converters/paragraph.js'
export { TextHTMLConverter } from './field/features/converters/html/converter/converters/text.js'

export { defaultHTMLConverters } from './field/features/converters/html/converter/defaultConverters.js'
export {
  convertLexicalNodesToHTML,
  convertLexicalToHTML,
} from './field/features/converters/html/converter/index.js'
export type { HTMLConverter } from './field/features/converters/html/converter/types.js'
export {
  HTMLConverterFeature,
  type HTMLConverterFeatureProps,
} from './field/features/converters/html/feature.server.js'
export {
  consolidateHTMLConverters,
  lexicalHTML,
} from './field/features/converters/html/field/index.js'
export { TestRecorderFeature } from './field/features/debug/testRecorder/feature.server.js'
export { TreeViewFeature } from './field/features/debug/treeView/feature.server.js'
export { BoldFeature } from './field/features/format/bold/feature.server.js'
export { InlineCodeFeature } from './field/features/format/inlineCode/feature.server.js'

export { ItalicFeature } from './field/features/format/italic/feature.server.js'
export { toolbarFormatGroupWithItems } from './field/features/format/shared/toolbarFormatGroup.js'
export { StrikethroughFeature } from './field/features/format/strikethrough/feature.server.js'
export { SubscriptFeature } from './field/features/format/subscript/feature.server.js'
export { SuperscriptFeature } from './field/features/format/superscript/feature.server.js'
export { UnderlineFeature } from './field/features/format/underline/feature.server.js'
export {
  HeadingFeature,
  type HeadingFeatureProps,
} from './field/features/heading/feature.server.js'
export { HorizontalRuleFeature } from './field/features/horizontalRule/feature.server.js'

export { IndentFeature } from './field/features/indent/feature.server.js'
export { LinkFeature, type LinkFeatureServerProps } from './field/features/link/feature.server.js'

export {
  $createAutoLinkNode,
  $isAutoLinkNode,
  AutoLinkNode,
} from './field/features/link/nodes/AutoLinkNode.js'
export {
  $createLinkNode,
  $isLinkNode,
  LinkNode,
  TOGGLE_LINK_COMMAND,
} from './field/features/link/nodes/LinkNode.js'
export type {
  LinkFields,
  SerializedAutoLinkNode,
  SerializedLinkNode,
} from './field/features/link/nodes/types.js'
export { ChecklistFeature } from './field/features/lists/checklist/feature.server.js'
export { OrderedListFeature } from './field/features/lists/orderedList/feature.server.js'
export { UnorderedListFeature } from './field/features/lists/unorderedList/feature.server.js'
export { LexicalPluginToLexicalFeature } from './field/features/migrations/lexicalPluginToLexical/feature.server.js'
export { SlateBlockquoteConverter } from './field/features/migrations/slateToLexical/converter/converters/blockquote/index.js'
export { SlateHeadingConverter } from './field/features/migrations/slateToLexical/converter/converters/heading/index.js'
export { SlateIndentConverter } from './field/features/migrations/slateToLexical/converter/converters/indent/index.js'
export { SlateLinkConverter } from './field/features/migrations/slateToLexical/converter/converters/link/index.js'
export { SlateListItemConverter } from './field/features/migrations/slateToLexical/converter/converters/listItem/index.js'
export { SlateOrderedListConverter } from './field/features/migrations/slateToLexical/converter/converters/orderedList/index.js'
export { SlateRelationshipConverter } from './field/features/migrations/slateToLexical/converter/converters/relationship/index.js'
export { SlateUnknownConverter } from './field/features/migrations/slateToLexical/converter/converters/unknown/index.js'
export { SlateUnorderedListConverter } from './field/features/migrations/slateToLexical/converter/converters/unorderedList/index.js'
export { SlateUploadConverter } from './field/features/migrations/slateToLexical/converter/converters/upload/index.js'
export { defaultSlateConverters } from './field/features/migrations/slateToLexical/converter/defaultConverters.js'

export {
  convertSlateNodesToLexical,
  convertSlateToLexical,
} from './field/features/migrations/slateToLexical/converter/index.js'
export type {
  SlateNode,
  SlateNodeConverter,
} from './field/features/migrations/slateToLexical/converter/types.js'
export { SlateToLexicalFeature } from './field/features/migrations/slateToLexical/feature.server.js'

export { ParagraphFeature } from './field/features/paragraph/feature.server.js'
export {
  RelationshipFeature,
  type RelationshipFeatureProps,
} from './field/features/relationship/feature.server.js'
export {
  $createRelationshipNode,
  $isRelationshipNode,
  type RelationshipData,
  RelationshipNode,
  type SerializedRelationshipNode,
} from './field/features/relationship/nodes/RelationshipNode.js'
export { toolbarAddDropdownGroupWithItems } from './field/features/shared/toolbar/addDropdownGroup.js'
export { toolbarFeatureButtonsGroupWithItems } from './field/features/shared/toolbar/featureButtonsGroup.js'

export { toolbarTextDropdownGroupWithItems } from './field/features/shared/toolbar/textDropdownGroup.js'
export { FixedToolbarFeature } from './field/features/toolbars/fixed/feature.server.js'
export { InlineToolbarFeature } from './field/features/toolbars/inline/feature.server.js'

export type { ToolbarGroup, ToolbarGroupItem } from './field/features/toolbars/types.js'
export { createNode } from './field/features/typeUtilities.js'
export type {
  AfterChangeNodeHook,
  AfterChangeNodeHookArgs,
  AfterReadNodeHook,
  AfterReadNodeHookArgs,
  BaseNodeHookArgs,
  BeforeChangeNodeHook,
  BeforeChangeNodeHookArgs,
  BeforeDuplicateNodeHook,
  BeforeDuplicateNodeHookArgs,
  BeforeValidateNodeHook,
  BeforeValidateNodeHookArgs,
  ClientComponentProps,
  ClientFeature,
  ClientFeatureProviderMap,
  FeatureProviderClient,
  FeatureProviderProviderClient,
  FeatureProviderProviderServer,
  FeatureProviderServer,
  NodeValidation,
  NodeWithHooks,
  PluginComponent,
  PluginComponentWithAnchor,
  PopulationPromise,
  ResolvedClientFeature,
  ResolvedClientFeatureMap,
  ResolvedServerFeature,
  ResolvedServerFeatureMap,
  SanitizedClientFeatures,
  SanitizedPlugin,
  SanitizedServerFeatures,
  ServerFeature,
  ServerFeatureProviderMap,
} from './field/features/types.js'

export { UploadFeature } from './field/features/upload/feature.server.js'

export type { UploadFeatureProps } from './field/features/upload/feature.server.js'
export {
  $createUploadNode,
  $isUploadNode,
  type SerializedUploadNode,
  type UploadData,
  UploadNode,
} from './field/features/upload/nodes/UploadNode.js'

export {
  type EditorConfigContextType,
  EditorConfigProvider,
  useEditorConfigContext,
} from './field/lexical/config/client/EditorConfigProvider.js'
export {
  sanitizeClientEditorConfig,
  sanitizeClientFeatures,
} from './field/lexical/config/client/sanitize.js'
export {
  defaultEditorConfig,
  defaultEditorFeatures,
  defaultEditorLexicalConfig,
} from './field/lexical/config/server/default.js'
export {
  loadFeatures,
  sortFeaturesForOptimalLoading,
} from './field/lexical/config/server/loader.js'

export {
  sanitizeServerEditorConfig,
  sanitizeServerFeatures,
} from './field/lexical/config/server/sanitize.js'
export type {
  ClientEditorConfig,
  SanitizedClientEditorConfig,
  SanitizedServerEditorConfig,
  ServerEditorConfig,
} from './field/lexical/config/types.js'

export { getEnabledNodes } from './field/lexical/nodes/index.js'
export { ENABLE_SLASH_MENU_COMMAND } from './field/lexical/plugins/SlashMenu/LexicalTypeaheadMenuPlugin/index.js'
export type { AdapterProps }

export type {
  SlashMenuGroup,
  SlashMenuItem,
} from './field/lexical/plugins/SlashMenu/LexicalTypeaheadMenuPlugin/types.js'
export { CAN_USE_DOM } from './field/lexical/utils/canUseDOM.js'
export { cloneDeep } from './field/lexical/utils/cloneDeep.js'
export { getDOMRangeRect } from './field/lexical/utils/getDOMRangeRect.js'
export { getSelectedNode } from './field/lexical/utils/getSelectedNode.js'
export { isHTMLElement } from './field/lexical/utils/guard.js'
export { invariant } from './field/lexical/utils/invariant.js'
export { joinClasses } from './field/lexical/utils/joinClasses.js'
export { createBlockNode } from './field/lexical/utils/markdown/createBlockNode.js'
export {
  DETAIL_TYPE_TO_DETAIL,
  DOUBLE_LINE_BREAK,
  ELEMENT_FORMAT_TO_TYPE,
  ELEMENT_TYPE_TO_FORMAT,
  IS_ALL_FORMATTING,
  LTR_REGEX,
  NON_BREAKING_SPACE,
  NodeFormat,
  RTL_REGEX,
  TEXT_MODE_TO_TYPE,
  TEXT_TYPE_TO_FORMAT,
  TEXT_TYPE_TO_MODE,
} from './field/lexical/utils/nodeFormat.js'
export { Point, isPoint } from './field/lexical/utils/point.js'
export { Rect } from './field/lexical/utils/rect.js'
export { setFloatingElemPosition } from './field/lexical/utils/setFloatingElemPosition.js'
export { setFloatingElemPositionForLinkEditor } from './field/lexical/utils/setFloatingElemPositionForLinkEditor.js'
export {
  addSwipeDownListener,
  addSwipeLeftListener,
  addSwipeRightListener,
  addSwipeUpListener,
} from './field/lexical/utils/swipe.js'
export { sanitizeUrl, validateUrl } from './field/lexical/utils/url.js'
export { defaultRichTextValue } from './populateGraphQL/defaultValue.js'

export type { LexicalEditorProps, LexicalRichTextAdapter } from './types.js'
