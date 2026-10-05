Interacting with items—like completing tasks, fixing sabotages, or hitting the emergency button—uses the exact same core pipeline as movement, but it adds a layer of validation to the game engine.
The LLM doesn't "click" on a wire to fix it; instead, it outputs an action command that the engine verifies against the character's physical location.
Here is how the architecture handles object interactions:
1. State Ingestion Includes Interactables
When the game engine serializes the environment into JSON for the prompt (as discussed in the movement blueprint), it includes contextual data about what the AI can touch in its current node.
 * Instead of just: {"location": "Electrical"}
 * It sends: {"location": "Electrical", "interactables": [{"type": "task", "name": "Fix Wiring", "status": "incomplete"}]}
2. The AI Outputs an Interaction Action
When the LLM formulates its JSON response, it selects an action other than "MOVE". The schema you define for the LLM must accept different action types.
For example, if an Impostor decides to kill a nearby crewmate, the JSON might look like:
{"action": "INTERACT", "target": "Player_3", "interaction_type": "KILL"}
If a Crewmate decides to do a task:
{"action": "INTERACT", "target": "Fix Wiring", "interaction_type": "TASK"}
3. The Game Engine Validates the Action
This is the most critical step. LLMs will frequently hallucinate or try to break the rules (e.g., trying to kill someone across the map, or doing a task they don't have). Your game engine must act as a strict referee.
When the engine receives the "INTERACT" command, it runs checks:
 * Distance Check: Is the AI's sprite physically close enough to the target object or player to interact with it?
 * State Check: Is the task actually assigned to this player? Is the Impostor's kill cooldown at zero? Is the target player still alive?
 * Line of Sight Check: (Optional) Are there walls blocking the interaction?
4. Execution and Feedback
If the action passes the checks, the game engine updates the game state (e.g., marking the task as complete, or spawning a dead body sprite).
If the action fails validation, the engine does not execute the action. Instead, in the next loop, it sends an error message back to the LLM in the prompt, such as: {"system_message": "Action Failed: You are too far away from 'Fix Wiring'."} This feedback loop trains the AI to correct its behavior on the next turn.