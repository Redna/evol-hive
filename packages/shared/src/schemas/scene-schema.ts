/**
 * Scene Definition JSON Schema (spec 022, Req 5)
 * ───────────────────────────────────────────────
 * A JSON Schema (Draft 2020-12) that validates the YAML-parsed scene
 * structure. This schema is the single source of truth for the declarative
 * scene format — the pipeline is "parse YAML → JSON object → validate against
 * this JSON Schema."
 *
 * The raw JSON file lives at `scene-schema.json` alongside this module.
 * Inlined here so tsup can bundle it (ESM doesn't resolve JSON imports).
 */

/** The JSON Schema (Draft 2020-12) for SceneDefinition validation. */
export const sceneDefinitionSchema = 
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://evol-hive.dev/schemas/scene-definition.json",
  "title": "SceneDefinition",
  "description": "Declarative scene definition for evol-hive (spec 022). Maps 1:1 to the SceneDefinition interface in packages/shared/src/types/world.ts.",
  "type": "object",
  "required": [
    "id",
    "name",
    "rooms",
    "objects",
    "agents"
  ],
  "additionalProperties": false,
  "properties": {
    "id": {
      "type": "string",
      "description": "Unique scene identifier."
    },
    "name": {
      "type": "string",
      "description": "Human-readable scene name."
    },
    "rooms": {
      "type": "array",
      "description": "Rooms in the scene.",
      "items": {
        "$ref": "#/$defs/Room"
      }
    },
    "objects": {
      "type": "array",
      "description": "Smart objects in the scene.",
      "items": {
        "$ref": "#/$defs/SmartObject"
      }
    },
    "agents": {
      "type": "array",
      "description": "Agent profiles in the scene.",
      "items": {
        "$ref": "#/$defs/AgentProfile"
      }
    }
  },
  "$defs": {
    "Room": {
      "type": "object",
      "required": [
        "id",
        "name",
        "description",
        "connections",
        "objectIds"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "description": "Unique room identifier."
        },
        "name": {
          "type": "string",
          "description": "Human-readable room name."
        },
        "description": {
          "type": "string",
          "description": "Room description for LLM perception."
        },
        "connections": {
          "type": "array",
          "description": "Connected room IDs (for spatial traversal).",
          "items": {
            "type": "string"
          }
        },
        "objectIds": {
          "type": "array",
          "description": "IDs of smart objects placed in this room.",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "SmartObject": {
      "type": "object",
      "required": [
        "id",
        "name",
        "type",
        "state",
        "affordances",
        "roomId"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "description": "Unique object identifier."
        },
        "name": {
          "type": "string",
          "description": "Display name."
        },
        "type": {
          "type": "string",
          "description": "Object type for affordance grouping (e.g., appliance, fixture, furniture, doorway, nature)."
        },
        "state": {
          "type": "object",
          "description": "Current JSON state of the object (arbitrary key-value map).",
          "additionalProperties": true
        },
        "roomId": {
          "type": "string",
          "description": "Room ID where this object is located."
        },
        "affordances": {
          "type": "array",
          "description": "Affordances this object supports.",
          "items": {
            "$ref": "#/$defs/Affordance"
          }
        },
        "stateRules": {
          "type": "array",
          "description": "Declarative state evolution rules applied each tick (spec 018).",
          "items": {
            "$ref": "#/$defs/ObjectStateRule"
          }
        },
        "compoundActions": {
          "type": "array",
          "description": "Multi-step action sequences for LLM context (spec 018).",
          "items": {
            "$ref": "#/$defs/CompoundAction"
          }
        },
        "dependencies": {
          "type": "array",
          "description": "Cross-object affordance dependencies (spec 018).",
          "items": {
            "$ref": "#/$defs/ObjectDependency"
          }
        }
      }
    },
    "Affordance": {
      "type": "object",
      "required": [
        "id",
        "label",
        "engineEffect",
        "preconditions",
        "effects"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "description": "Semantic affordance ID (e.g., brew_coffee)."
        },
        "label": {
          "type": "string",
          "description": "Human/LLM-readable description."
        },
        "engineEffect": {
          "type": "string",
          "description": "The deterministic engine function to invoke."
        },
        "preconditions": {
          "type": "array",
          "description": "Precondition check names the engine runs before executing.",
          "items": {
            "type": "string"
          }
        },
        "effects": {
          "type": "object",
          "description": "Drive impacts applied on success (e.g., { energy: 20 }).",
          "additionalProperties": {
            "type": "number"
          }
        },
        "stepGroup": {
          "type": "string",
          "description": "Semantic group name linking related affordances into a multi-step sequence (spec 018)."
        },
        "stepOrder": {
          "type": "number",
          "description": "1-based ordinal indicating the step's position within its stepGroup (spec 018)."
        },
        "conditions": {
          "type": "array",
          "description": "Structured conditions evaluated at perception time to determine availability (spec 018).",
          "items": {
            "$ref": "#/$defs/AffordanceCondition"
          }
        },
        "targetAgentId": {
          "type": "string",
          "description": "Reserved for future social affordances targeting other agents."
        }
      }
    },
    "AffordanceCondition": {
      "type": "object",
      "required": [
        "field",
        "operator",
        "value"
      ],
      "additionalProperties": false,
      "properties": {
        "field": {
          "type": "string",
          "description": "A key in SmartObject.state."
        },
        "operator": {
          "type": "string",
          "enum": [
            ">",
            "<",
            ">=",
            "<=",
            "==",
            "!="
          ],
          "description": "The comparison operator to apply."
        },
        "value": {
          "type": [
            "number",
            "string",
            "boolean"
          ],
          "description": "The comparison target value."
        }
      }
    },
    "ObjectStateRule": {
      "type": "object",
      "required": [
        "field",
        "operation",
        "rate",
        "interval"
      ],
      "additionalProperties": false,
      "properties": {
        "field": {
          "type": "string",
          "description": "A key in SmartObject.state whose value must be a number."
        },
        "operation": {
          "type": "string",
          "enum": [
            "decay",
            "approach"
          ],
          "description": "The evolution operation."
        },
        "rate": {
          "type": "number",
          "description": "Rate of change per second."
        },
        "target": {
          "type": "number",
          "description": "Target value for approach operation."
        },
        "interval": {
          "type": "number",
          "description": "Minimum time in seconds between applications (throttling)."
        }
      }
    },
    "CompoundAction": {
      "type": "object",
      "required": [
        "id",
        "label",
        "steps"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "description": "Semantic name (e.g., brew_coffee_sequence)."
        },
        "label": {
          "type": "string",
          "description": "Human-readable description."
        },
        "steps": {
          "type": "array",
          "description": "Ordered list mapping to affordance IDs on this object.",
          "items": {
            "type": "object",
            "required": [
              "affordanceId",
              "description"
            ],
            "additionalProperties": false,
            "properties": {
              "affordanceId": {
                "type": "string"
              },
              "description": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "ObjectDependency": {
      "type": "object",
      "required": [
        "affordanceId",
        "requiresObjectId",
        "requiresAffordance",
        "description"
      ],
      "additionalProperties": false,
      "properties": {
        "affordanceId": {
          "type": "string",
          "description": "The affordance on this object that has the dependency."
        },
        "requiresObjectId": {
          "type": "string",
          "description": "The ID of the object that must be interacted with first."
        },
        "requiresAffordance": {
          "type": "string",
          "description": "The affordance on the required object that must be executed first."
        },
        "description": {
          "type": "string",
          "description": "Human-readable explanation for LLM context."
        }
      }
    },
    "AgentProfile": {
      "type": "object",
      "required": [
        "id",
        "name",
        "description",
        "traits",
        "initialDrives"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "description": "Unique agent identifier."
        },
        "name": {
          "type": "string",
          "description": "Agent display name."
        },
        "description": {
          "type": "string",
          "description": "Agent description."
        },
        "traits": {
          "type": "array",
          "description": "Personality traits that influence LLM system prompts.",
          "items": {
            "type": "string"
          }
        },
        "initialDrives": {
          "type": "object",
          "description": "Initial drive values at spawn (partial AgentDrives).",
          "additionalProperties": {
            "type": "number"
          }
        },
        "backstory": {
          "type": "string",
          "description": "A short backstory for the agent, injected into the LLM system prompt."
        },
        "longTermGoals": {
          "type": "array",
          "description": "Long-term goals and aspirations.",
          "items": {
            "type": "string"
          }
        },
        "behavioralTendencies": {
          "type": "array",
          "description": "Behavioral tendencies (e.g., risk-averse, curious).",
          "items": {
            "type": "string"
          }
        },
        "speechStyle": {
          "type": "string",
          "description": "Speech style / tone preferences."
        },
        "relationships": {
          "type": "object",
          "description": "Relationships with other agents, keyed by agent ID.",
          "additionalProperties": {
            "type": "string"
          }
        },
        "startRoomId": {
          "type": "string",
          "description": "Optional room ID where the agent spawns. When absent, the first room is used."
        }
      }
    }
  }
};
